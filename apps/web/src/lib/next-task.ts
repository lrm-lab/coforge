export function nextTask(run: () => void) {
  if (typeof MessageChannel === "undefined") return void setTimeout(run, 0);
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    run();
  };
  channel.port2.postMessage(undefined);
}
