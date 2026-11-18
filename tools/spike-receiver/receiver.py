# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets>=13"]
# ///
"""Spike receiver: stands in for the desktop app during Phase 0.

serve  - accept the extension's WebSocket, record everything to a session folder
dump   - decode the raw data-channel frames of a recorded session (protobuf tree)
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import gzip
import json
import struct
import time
import wave
from collections import Counter
from datetime import datetime
from pathlib import Path

RATE = 16000
HEADER = struct.Struct("<BIQ")  # stream, seq, t_ms


class Session:
    def __init__(self, root: Path):
        self.dir = root / datetime.now().strftime("%Y%m%d-%H%M%S")
        self.dir.mkdir(parents=True)
        self.events = (self.dir / "events.jsonl").open("w", encoding="utf-8")
        self.index = (self.dir / "audio-index.csv").open("w", encoding="utf-8")
        self.index.write("stream,seq,t_ms,samples\n")
        self.wavs: dict[int, wave.Wave_write] = {}
        self.last_seq: dict[int, int] = {}
        self.counts: Counter[str] = Counter()

    def json(self, msg: dict) -> None:
        msg["recv"] = round(time.time() * 1000)
        self.events.write(json.dumps(msg, ensure_ascii=False) + "\n")
        kind = msg.get("kind", "?")
        key = f"raw:{msg.get('label')}:{msg.get('dir')}" if kind == "raw" else kind
        self.counts[key] += 1
        if kind in ("log", "stream", "meeting", "meeting_end", "participant", "source", "source_removed"):
            shown = {k: v for k, v in msg.items() if k not in ("recv", "tab", "t", "avatar")}
            print("  ", json.dumps(shown, ensure_ascii=False))

    def audio(self, frame: bytes) -> None:
        stream, seq, t_ms = HEADER.unpack_from(frame)
        pcm = frame[HEADER.size:]
        w = self.wavs.get(stream)
        if w is None:
            w = wave.open(str(self.dir / f"stream-{stream}.wav"), "wb")
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            self.wavs[stream] = w
        last = self.last_seq.get(stream)
        if last is not None and seq != last + 1 and seq != 0:
            self.counts[f"gap:{stream}"] += 1
        self.last_seq[stream] = seq
        w.writeframes(pcm)
        self.index.write(f"{stream},{seq},{t_ms},{len(pcm) // 2}\n")
        self.counts[f"audio:{stream}"] += 1

    def stats(self) -> str:
        return "  ".join(f"{k}={v}" for k, v in sorted(self.counts.items()))

    def close(self) -> None:
        for w in self.wavs.values():
            w.close()
        self.events.close()
        self.index.close()


async def serve(args: argparse.Namespace) -> None:
    from websockets.asyncio.server import serve as ws_serve

    async def handler(ws) -> None:
        origin = ws.request.headers.get("Origin", "")
        if not args.any_origin and not origin.startswith("moz-extension://"):
            print(f"rejected origin {origin!r}")
            await ws.close(4403, "origin")
            return
        try:
            hello = json.loads(await asyncio.wait_for(ws.recv(), 5))
        except Exception:
            await ws.close(4401, "hello")
            return
        if hello.get("kind") != "hello" or hello.get("token") != args.token:
            print("rejected: bad token")
            await ws.close(4401, "token")
            return

        session = Session(Path(args.out))
        print(f"connected from {origin}; recording to {session.dir}")

        async def report() -> None:
            while True:
                await asyncio.sleep(5)
                print(session.stats())

        reporter = asyncio.create_task(report())
        try:
            async for message in ws:
                if isinstance(message, bytes):
                    session.audio(message)
                else:
                    session.json(json.loads(message))
        finally:
            reporter.cancel()
            session.close()
            print(f"closed {session.dir}\n{session.stats()}")

    async with ws_serve(handler, args.host, args.port, max_size=2**22):
        print(f"listening on ws://{args.host}:{args.port}")
        await asyncio.Future()


# ---- protobuf wire-format walker (no schema) --------------------------------

def varint(buf: bytes, p: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        b = buf[p]
        p += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, p
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")


def walk(buf: bytes) -> list[tuple[int, object]]:
    """Parse buf as a protobuf message or raise ValueError."""
    out: list[tuple[int, object]] = []
    p = 0
    try:
        while p < len(buf):
            tag, p = varint(buf, p)
            field, wire = tag >> 3, tag & 7
            if field == 0:
                raise ValueError("field 0")
            if wire == 0:
                v, p = varint(buf, p)
                out.append((field, v))
            elif wire == 2:
                n, p = varint(buf, p)
                if p + n > len(buf):
                    raise ValueError("length overrun")
                out.append((field, buf[p:p + n]))
                p += n
            elif wire == 1:
                out.append((field, f"fixed64:{buf[p:p + 8].hex()}"))
                p += 8
            elif wire == 5:
                out.append((field, f"fixed32:{buf[p:p + 4].hex()}"))
                p += 4
            else:
                raise ValueError(f"wire type {wire}")
    except IndexError as e:
        raise ValueError("truncated") from e
    return out


def render(buf: bytes, depth: int = 0, max_depth: int = 12) -> list[str]:
    pad = "  " * depth
    lines: list[str] = []
    for field, value in walk(buf):
        if not isinstance(value, bytes):
            lines.append(f"{pad}{field}: {value}")
            continue
        if value[:3] == b"\x1f\x8b\x08":
            try:
                value = gzip.decompress(value)
                lines.append(f"{pad}{field}: <gzip>")
            except OSError:
                pass
        text = None
        try:
            s = value.decode("utf-8")
            # Control characters mean it is more likely a nested message.
            if s and all(c.isprintable() for c in s):
                text = s
        except UnicodeDecodeError:
            pass
        nested = None
        if value and depth < max_depth and text is None:
            try:
                nested = render(value, depth + 1, max_depth)
            except ValueError:
                nested = None
        if text is not None:
            lines.append(f"{pad}{field}: {text!r}")
        elif nested is not None:
            lines.append(f"{pad}{field}: {{")
            lines.extend(nested)
            lines.append(f"{pad}}}")
        else:
            lines.append(f"{pad}{field}: bytes[{len(value)}] {value[:24].hex()}")
    return lines


def readable(data: bytes) -> str | None:
    """The frame as JSON or plain text, or None if it is neither."""
    try:
        s = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    try:
        return json.dumps(json.loads(s), ensure_ascii=False, indent=2)
    except ValueError:
        pass
    # Short protobuf frames can pass for text; real text has few control characters.
    if len(s) >= 8 and all(c.isprintable() or c in "\r\n\t" for c in s):
        return s
    return None


def dump(args: argparse.Namespace) -> None:
    shown = 0
    with (Path(args.session) / "events.jsonl").open(encoding="utf-8") as f:
        for line in f:
            m = json.loads(line)
            if m.get("kind") != "raw":
                continue
            if args.label and m.get("label") != args.label:
                continue
            if args.dir and m.get("dir") != args.dir:
                continue
            data = base64.b64decode(m["b64"])
            if data[:3] == b"\x1f\x8b\x08":
                data = gzip.decompress(data)
            print(f"--- {m['label']} {m['dir']} t={m['t']:.0f} bytes={len(data)}")
            # Not everything is protobuf: sockets and HTTP answers are mostly text.
            text = readable(data)
            if text is not None:
                print(text)
                shown += 1
                if shown >= args.limit:
                    break
                continue
            try:
                print("\n".join(render(data)))
            except ValueError as e:
                print(f"  not protobuf ({e}): {data[:48].hex()}")
            shown += 1
            if shown >= args.limit:
                break


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=17865)
    s.add_argument("--token", default="dev")
    s.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "recordings"))
    s.add_argument("--any-origin", action="store_true", help="accept non-extension clients (tests)")
    d = sub.add_parser("dump")
    d.add_argument("session")
    d.add_argument("--label")
    d.add_argument("--dir", choices=["in", "out"])
    d.add_argument("--limit", type=int, default=20)
    args = ap.parse_args()
    if args.cmd == "serve":
        try:
            asyncio.run(serve(args))
        except KeyboardInterrupt:
            pass
    else:
        dump(args)


if __name__ == "__main__":
    main()
