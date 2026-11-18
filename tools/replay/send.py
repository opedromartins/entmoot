# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets>=13"]
# ///
"""Sends a recorded session to the app over WebSocket, as the extension would.

    uv run tools/replay/send.py recordings/<session> [--speed 20]
"""
import argparse
import asyncio
import csv
import json
import struct
import wave
from pathlib import Path

from websockets.asyncio.client import connect


def load(session: Path):
    items = []
    for name in ("events.jsonl", "decoded.jsonl"):
        path = session / name
        if not path.exists():
            continue
        for line in path.open(encoding="utf-8"):
            m = json.loads(line)
            if m.get("kind") in ("raw", "log"):
                continue
            items.append((m.get("t", 0), line.strip()))
    wavs = {}
    with (session / "audio-index.csv").open() as f:
        for row in csv.DictReader(f):
            stream, n = int(row["stream"]), int(row["samples"])
            if n == 0:
                continue
            if stream not in wavs:
                wavs[stream] = wave.open(str(session / f"stream-{stream}.wav"))
            header = struct.pack("<BIQ", stream, int(row["seq"]), int(row["t_ms"]))
            items.append((int(row["t_ms"]), header + wavs[stream].readframes(n)))
    items.sort(key=lambda i: i[0])
    return items


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("session", type=Path)
    ap.add_argument("--url", default="ws://127.0.0.1:17865")
    ap.add_argument("--token", default="dev")
    ap.add_argument("--speed", type=float, default=20.0, help="times real time")
    args = ap.parse_args()
    items = load(args.session)
    start = next(t for t, i in items if isinstance(i, bytes))
    async with connect(args.url, origin="moz-extension://replay") as ws:
        await ws.send(json.dumps({"kind": "hello", "token": args.token}))
        clock = asyncio.get_running_loop().time()
        for t, item in items:
            due = clock + max(0, t - start) / 1000 / args.speed
            await asyncio.sleep(max(0, due - asyncio.get_running_loop().time()))
            await ws.send(item)
    print(f"sent {len(items)} items")


asyncio.run(main())
