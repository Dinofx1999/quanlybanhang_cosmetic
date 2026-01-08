const http = require("http");
const { Server } = require("socket.io");

const { env } = require("./config/env");
const { connectDB } = require("./db");
const { createApp } = require("./app");

async function main() {
  await connectDB();

  const app = createApp();
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: { origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN },
  });

  // lưu io vào app để routes dùng (emit)
  app.set("io", io);

  io.on("connection", (socket) => {
    socket.on("joinBranch", (branchId) => {
      if (branchId) socket.join(`branch:${branchId}`);
    });
  });

  server.listen(env.PORT, () => {
    console.log(`Server running :${env.PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
