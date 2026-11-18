// The audio tap of page-hook.js as a file of its own, for pages whose policy
// refuses a worklet made from a blob. Keep makeFramer and the numbers equal
// to the ones there.
function makeFramer(inRate, outRate, frameSamples, emit) {
  const step = inRate / outRate;
  let pos = 0, acc = 0, n = 0;
  let buf = new Int16Array(frameSamples), i = 0, seq = 0;
  return (input) => {
    for (let k = 0; k < input.length; k++) {
      acc += input[k]; n++; pos += 1;
      if (pos >= step) {
        pos -= step;
        const v = Math.max(-1, Math.min(1, acc / n));
        acc = 0; n = 0;
        buf[i++] = v * 32767;
        if (i === frameSamples) {
          emit(buf.buffer, seq++, k);
          buf = new Int16Array(frameSamples); i = 0;
        }
      }
    }
  };
}

class MtTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.feed = makeFramer(sampleRate, 16000, 1600,
      (buf, seq, k) => this.port.postMessage({ buf, seq, end: currentTime + (k + 1) / sampleRate }, [buf]));
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.feed(ch);
    return true;
  }
}
registerProcessor('mt-tap', MtTap);
