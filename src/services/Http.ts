import { warn, error as logError, info } from "../utils/console";
import config from "../config";

interface EventPayload {
  type: string;
  [key: string]: unknown;
}

class HttpService {
  private readonly baseURL: string;
  private readonly timeout: number;
  private readonly headers: Record<string, string>;
  private readonly endpoint = "/events";
  private readonly serviceName = "Http";

  constructor() {
    this.baseURL = config.CORE_URL;
    this.timeout = config.HTTP_TIMEOUT;
    const secretKey = config.SECRET_KEY;

    this.headers = {
      "Content-Type": "application/json",
      ...(secretKey && { Authorization: `Bearer ${secretKey}` }),
    };

    info(this.serviceName, "HTTP client initialized", { baseURL: this.baseURL, timeout: this.timeout });
  }

  async post<T = any>(data: EventPayload): Promise<T | void> {
    const url = `${this.baseURL}${this.endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.text();
        logError(this.serviceName, "Server error", {
          endpoint: this.endpoint,
          status: response.status,
          statusText: response.statusText,
          data: errorData,
        });
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json() as T;
    } catch (error) {
      this.handleError(error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Post without throwing - useful for fire-and-forget events
   */
  async postSafe(data: EventPayload): Promise<boolean> {
    try {
      await this.post(data);
      return true;
    } catch (error) {
      // Already logged, just return false
      return false;
    }
  }

  /**
   * Check if the client is available
   */
  isAvailable(): boolean {
    return true;
  }

  private handleError(error: unknown): void {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        logError(this.serviceName, "Request timeout", {
          endpoint: this.endpoint,
          message: error.message,
        });
      } else if (error.message.startsWith("HTTP ")) {
        // Server responded with error status - already logged in post()
        return;
      } else {
        // Network error or other failure
        logError(this.serviceName, "Request failed", {
          endpoint: this.endpoint,
          message: error.message,
        });
      }
    }
  }
}

// Export singleton instance
export const httpService = new HttpService();

// Also export class for testing or custom instances
export { HttpService };
