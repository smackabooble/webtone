import { analyze } from './dsp/analyze';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

scope.onmessage = (e) => {
  const { mono, sr } = e.data as { mono: Float32Array; sr: number };
  const result = analyze(mono, sr);
  scope.postMessage(result, [result.f0.buffer, result.marks.buffer, result.env.buffer]);
};
