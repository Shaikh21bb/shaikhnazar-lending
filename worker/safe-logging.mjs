// libsignal writes full session objects directly to console, bypassing pino.
// Keep connection diagnostics, but never print linked-device keys.
for (const method of ['log', 'info', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        const label = typeof args[0] === 'string' ? args[0] : '';
        if (/^(Closing session:|Session already closed|Unhandled bucket type|V1 session storage migration error)/.test(label)) {
            original('[WhatsApp encryption] session state updated');
        } else if (label.startsWith('Session error:')) {
            original('[WhatsApp encryption] could not decrypt with one session');
        } else original(...args);
    };
}
