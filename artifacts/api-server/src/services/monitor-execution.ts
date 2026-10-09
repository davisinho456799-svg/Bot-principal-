export class MonitorUnavailableError extends Error {}

/** Process-local coordination: automatic checks take priority over diagnostics. */
export class MonitorExecution {
  private regular = false;
  private diagnostic?: { controller: AbortController; done: Promise<void> };

  async runRegular<T>(operation: () => Promise<T>): Promise<T> {
    if (this.regular) throw new MonitorUnavailableError("Já existe uma verificação do monitor em andamento.");
    this.regular = true;
    try {
      if (this.diagnostic) {
        this.diagnostic.controller.abort();
        await this.diagnostic.done;
      }
      return await operation();
    } finally {
      this.regular = false;
    }
  }

  async runDiagnostic<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.regular || this.diagnostic) {
      throw new MonitorUnavailableError("O monitor já está ocupado. Tente o diagnóstico depois da verificação atual.");
    }
    const controller = new AbortController();
    let release!: () => void;
    const diagnostic = { controller, done: new Promise<void>(resolve => { release = resolve; }) };
    this.diagnostic = diagnostic;
    try {
      return await operation(controller.signal);
    } finally {
      this.diagnostic = undefined;
      release();
    }
  }
}

export const monitorExecution = new MonitorExecution();