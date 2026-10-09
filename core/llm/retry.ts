/**
 * Exponential backoff aur jitter ke saath fetch request ko retry karne ke liye helper function.
 * 429 aur 5xx status codes par retry karega, 400/401 par nahi karega.
 * Retry-After header ko bhi honor karta hai.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxAttempts = 3,
  baseDelay = 1000
): Promise<Response> {
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const response = await fetch(url, options);

      if (response.ok) {
        return response;
      }

      if (response.status === 400 || response.status === 401) {
        return response;
      }

      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        if (attempt >= maxAttempts) {
          return response;
        }

        const retryAfterHeader = response.headers.get("Retry-After");
        let delay = baseDelay * Math.pow(2, attempt);
        
        if (retryAfterHeader) {
          const seconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(seconds)) {
            delay = seconds * 1000;
          }
        } else {
          const jitter = Math.random() * 200;
          delay = delay + jitter;
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return response;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      const delay = baseDelay * Math.pow(2, attempt) + (Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error("Maximum retry attempts reached");
}
