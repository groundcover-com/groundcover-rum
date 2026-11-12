const unpatchedConsoleLog = console.log.bind(console);

interface LoggerConfig {
  debug?: boolean;
  prefix?: string;
}

export class Logger {
  private static instance: Logger;
  private isDebugEnabled: boolean;
  private prefix: string;

  private constructor() {
    this.isDebugEnabled = false;
    this.prefix = '';
  }

  static initialize(config?: LoggerConfig): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }

    if (config) {
      Logger.instance.isDebugEnabled = config.debug ?? false;
      Logger.instance.prefix = config.prefix ?? '';
    }
    
    return Logger.instance;
  }

  static getInstance(config?: LoggerConfig): Logger {
    return Logger?.instance || Logger.initialize(config);
  }

  private formatMessage(message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] ${this.prefix} ${message}`;
  }

  log(message: string, ...args: unknown[]): void {
    if (this.isDebugEnabled) {
      unpatchedConsoleLog(this.formatMessage(message), ...args);
    }
  }

  updateConfig(config: LoggerConfig): void {
    this.isDebugEnabled = config.debug ?? this.isDebugEnabled;
    this.prefix = config.prefix ?? this.prefix;
  }
}

