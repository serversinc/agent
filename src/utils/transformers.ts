import { ContainerInfo } from "dockerode";

/**
 * Splits a "repo:tag" or "repo@sha256:digest" reference into its name and tag,
 * treating a colon that's part of a registry host:port (e.g. localhost:5000/image) as not a tag separator.
 */
function parseImageTag(image: string): { name: string; tag: string } {
  const lastColon = image.lastIndexOf(":");
  if (lastColon === -1 || image.indexOf("/") > lastColon) {
    return { name: image, tag: "latest" };
  }
  return { name: image.substring(0, lastColon), tag: image.substring(lastColon + 1) || "latest" };
}

/**
 * Normalizes container data from Dockerode
 * @param container Container data from Dockerode
 * @returns Normalized container data
 */
export function normalizeContainer(container: ContainerInfo) {
  const { name: imageName, tag } = parseImageTag(container.Image);

  return {
    id: container.Id,
    name: container.Names[0],
    image: {
      name: imageName,
      id: container.ImageID,
      tag,
    },
    state: container.State,
    ports: container.Ports.map(port => ({
      type: port.Type,
      ip: port.IP,
      private: port.PrivatePort,
      public: port.PublicPort,
    })),
    command: container.Command,
    created: container.Created,
    created_normalized: new Date(container.Created * 1000),
    networks: Object.keys(container.NetworkSettings.Networks).map(key => ({
      ip: container.NetworkSettings.Networks[key].IPAddress,
      name: key,
      mac_address: container.NetworkSettings.Networks[key].MacAddress,
      network_id: container.NetworkSettings.Networks[key].NetworkID,
      endpoint_id: container.NetworkSettings.Networks[key].EndpointID,
      gateway: container.NetworkSettings.Networks[key].Gateway,
      aliases: container.NetworkSettings.Networks[key].Aliases,
    })),
  };
}

/**
 * Strips ANSI codes from a string
 * @param input String with ANSI codes
 * @returns String without ANSI codes
 * @example
 * stripAnsiCodes("\x1b[31mHello\x1b[0m") // "Hello"
 */
export function stripAnsiCodes(input: string): string {
  return input.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

/**
 * Demultiplexes a Docker stream buffer into stdout and stderr
 * @param buffer Buffer containing the Docker stream data
 * @returns An object with `stdout` and `stderr` properties containing the respective output
 */
export function demultiplexDockerStream(buffer: Buffer): { stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;

    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    
    if (offset + 8 + size > buffer.length) break;

    const data = buffer.slice(offset + 8, offset + 8 + size).toString('utf8');
    
    if (streamType === 1) {
      stdout += data; // STDOUT
    } else if (streamType === 2) {
      stderr += data; // STDERR
    }
    
    offset += 8 + size;
  }

  return { stdout, stderr };
}