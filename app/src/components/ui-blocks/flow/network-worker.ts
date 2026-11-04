// The network layout off the main thread, for graphs of WORKER_MIN nodes or more. Same function,
// same seed: the result is the one the main thread would compute. A module worker served from the
// app itself, so `script-src 'self'` covers it; it receives data, never code.
import { layoutNetwork, type NetIn } from "@/components/ui-blocks/flow/network-layout";

self.onmessage = (e: MessageEvent<{ id: number; input: NetIn }>) => {
  self.postMessage({ id: e.data.id, out: layoutNetwork(e.data.input) });
};
