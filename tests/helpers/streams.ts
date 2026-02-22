import { Buffer } from "buffer";

// Create a docker multiplexed stream buffer: [1 byte stream][3 bytes zero][4 bytes size][payload]
function makeFrame(streamType: number, payload: Buffer) {
  const header = Buffer.alloc(8);
  header[0] = streamType; // 1 stdout, 2 stderr
  // bytes 1-3 are zeros
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

export function makeDockerMuxedBuffer(stdout: string | Buffer, stderr: string | Buffer) {
  const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), "utf8");
  const errBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr), "utf8");

  const frames: Buffer[] = [];
  if (outBuf.length > 0) frames.push(makeFrame(1, outBuf));
  if (errBuf.length > 0) frames.push(makeFrame(2, errBuf));

  return Buffer.concat(frames);
}
