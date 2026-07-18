export class ProcessingError extends Error {
  constructor(message, retryable = true) {
    super(message);
    this.name = 'ProcessingError';
    this.retryable = retryable;
  }
}

export function normalizeProcessingError(error) {
  if (error instanceof ProcessingError) return error;
  return new ProcessingError(error?.message || '图片处理失败', true);
}
