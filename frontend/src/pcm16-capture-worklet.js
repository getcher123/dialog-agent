const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 320;

class Pcm16CaptureWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputSampleRate = sampleRate;
    this.resampleRatio = this.inputSampleRate / TARGET_SAMPLE_RATE;
    this.pendingInput = [];
    this.readIndex = 0;
    this.pendingOutput = [];
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (output) {
      output.fill(0);
    }

    if (!input?.length) {
      return true;
    }

    for (let index = 0; index < input.length; index += 1) {
      this.pendingInput.push(input[index]);
    }

    while (this.readIndex + this.resampleRatio < this.pendingInput.length) {
      const baseIndex = Math.floor(this.readIndex);
      const nextIndex = Math.min(baseIndex + 1, this.pendingInput.length - 1);
      const mix = this.readIndex - baseIndex;
      const left = this.pendingInput[baseIndex] ?? 0;
      const right = this.pendingInput[nextIndex] ?? left;
      const interpolated = left + (right - left) * mix;
      const clamped = Math.max(-1, Math.min(1, interpolated));
      const sample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

      this.pendingOutput.push(Math.round(sample));
      this.readIndex += this.resampleRatio;
    }

    const consumed = Math.floor(this.readIndex);
    if (consumed > 0) {
      this.pendingInput.splice(0, consumed);
      this.readIndex -= consumed;
    }

    while (this.pendingOutput.length >= CHUNK_SAMPLES) {
      const frame = new Int16Array(this.pendingOutput.splice(0, CHUNK_SAMPLES));
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm16-capture-worklet", Pcm16CaptureWorklet);
