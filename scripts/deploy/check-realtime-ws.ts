const url = Bun.env.REALTIME_URL;
if (!url) {
  console.error("REALTIME_URL is not set");
  process.exit(1);
}
const socket = new WebSocket(url);
const fail = () => {
  console.error("Realtime WebSocket handshake failed");
  process.exit(1);
};
setTimeout(fail, 10000);
socket.onerror = fail;
socket.onclose = fail;
socket.onopen = () => {
  console.log("Realtime WebSocket handshake succeeded");
  socket.close();
  process.exit(0);
};
