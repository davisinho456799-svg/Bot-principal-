import { gotScraping } from "got-scraping";

const COMICK_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://comick.io",
  Referer: "https://comick.io/",
};

export interface ComickHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Faz uma requisição com o perfil de navegador usado pelo Comick.
 *
 * O retorno não lança exceção para status HTTP: os chamadores precisam
 * diferenciar 403, 404, 429 e 5xx conforme a operação que estão executando.
 * Erros de rede, timeout e falhas de parsing continuam sendo propagados.
 */
export async function fetchComick(url: string): Promise<ComickHttpResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await gotScraping({
        url,
        headers: COMICK_HEADERS,
        headerGeneratorOptions: {
          browsers: [{ name: "chrome", minVersion: 120 }],
          operatingSystems: ["windows"],
          locales: ["en-US", "en"],
        },
        http2: true,
        followRedirect: true,
        throwHttpErrors: false,
        timeout: { request: 25_000 },
      });
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        statusText: response.statusMessage || String(response.statusCode),
        body: response.body,
        headers: Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value)]),
        ),
      };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
export function parseComickJson<T>(response: ComickHttpResponse): T {
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new Error(
      `Comick retornou conteúdo inválido (HTTP ${response.status}): ${response.body.slice(0, 200)}`,
    );
  }
}