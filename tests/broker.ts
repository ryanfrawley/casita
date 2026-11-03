// An in-process MQTT broker (aedes) on a local TCP port, for integration tests.

import net from "node:net";
import { Aedes } from "aedes";

/** A TCP listener for the broker that can be taken down and brought back on the same port. */
export class Broker {
  port = 0;
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();

  private constructor(private readonly aedes: Aedes) {}

  static async start(): Promise<Broker> {
    const broker = new Broker(await Aedes.createBroker());
    await broker.up();
    return broker;
  }

  get url(): string {
    return `mqtt://127.0.0.1:${this.port}`;
  }

  up(): Promise<void> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        this.aedes.handle(socket);
      });
      this.server = server;
      server.listen(this.port, "127.0.0.1", () => {
        this.port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  /** Stops listening and cuts every connection; retained messages survive. */
  down(): Promise<void> {
    return new Promise((resolve) => {
      for (const socket of this.sockets) socket.destroy();
      this.server?.close(() => resolve());
    });
  }

  async stop(): Promise<void> {
    await this.down();
    await new Promise<void>((resolve) => this.aedes.close(resolve));
  }
}
