// Errors as RFC 9457 problems with a stable UPPER_SNAKE code, the same shape as the Kotlin services.

export interface Violation {
    field: string;
    message: string;
}

/** An expected failure: the caller gets [status] with [code]; everything else is a 500. */
export class AppError extends Error {
    readonly status: number;
    readonly code: string;
    readonly title: string;
    readonly violations?: Violation[];
    readonly headers?: Record<string, string>;

    constructor(status: number, code: string, title: string, violations?: Violation[], headers?: Record<string, string>) {
        super(title);
        this.status = status;
        this.code = code;
        this.title = title;
        this.violations = violations;
        this.headers = headers;
    }

    static invalid(code: string, violations: Violation[]): AppError {
        return new AppError(422, code, 'The request is invalid', violations);
    }

    static notFound(code: string, title: string): AppError {
        return new AppError(404, code, title);
    }
}

export function problem(status: number, code: string, title: string, extra: { violations?: Violation[]; headers?: Record<string, string> } = {}): Response {
    const body = {
        type: 'about:blank',
        title,
        status,
        code,
        ...(extra.violations
            ? { violations: extra.violations }
            : {}),
    };
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/problem+json', ...extra.headers },
    });
}
