# Packs the extension into dist/entmoot.xpi.
#   powershell -ExecutionPolicy Bypass -File extension\build.ps1
# The package is unsigned: only Zen, Developer Edition, Nightly and ESR accept
# it, and only with xpinstall.signatures.required set to false in about:config.
#
# With -Sign, Mozilla signs it (unlisted channel) and any Firefox installs it:
#   powershell -ExecutionPolicy Bypass -File extension\build.ps1 -Sign
# Needs Node and the AMO credentials in WEB_EXT_API_KEY (JWT issuer) and
# WEB_EXT_API_SECRET. Each version can be signed only once: bump "version" in
# manifest.json first.
param([switch]$Sign)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$out = Join-Path $dist 'entmoot.xpi'
New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $out) { Remove-Item $out }

if ($Sign) {
    foreach ($name in 'WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET') {
        if (-not [Environment]::GetEnvironmentVariable($name)) { throw "$name is not set." }
    }

    # web-ext names the file after the add-on id and version; an empty folder
    # of its own makes the result easy to find.
    $signed = Join-Path $dist 'signed'
    if (Test-Path $signed) { Remove-Item $signed -Recurse -Force }

    # web-ext reads the credentials from the environment, so they stay out of
    # the command line and the logs.
    & npx --yes web-ext@10 sign --source-dir $root --channel unlisted --artifacts-dir $signed --ignore-files 'build.ps1' 'dist/**'
    if ($LASTEXITCODE -ne 0) { throw "web-ext sign failed (exit code $LASTEXITCODE)." }

    $xpi = @(Get-ChildItem $signed -Filter '*.xpi')
    if ($xpi.Count -ne 1) { throw "Expected one signed .xpi in $signed, found $($xpi.Count)." }
    Move-Item $xpi[0].FullName $out
    Remove-Item $signed -Recurse -Force
    Write-Host "$out (signed)"
    return
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$files = @(Get-Item (Join-Path $root 'manifest.json')) + @(Get-ChildItem (Join-Path $root 'src') -Recurse -File) + @(Get-ChildItem (Join-Path $root 'icons') -Recurse -File)
$zip = [IO.Compression.ZipFile]::Open($out, 'Create')
try {
    foreach ($file in $files) {
        # Firefox needs forward slashes in entry names; Compress-Archive writes backslashes.
        $name = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $name) | Out-Null
    }
} finally {
    $zip.Dispose()
}
Write-Host "$out ($($files.Count) files)"
