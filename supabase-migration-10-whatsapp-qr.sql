-- Private state for the optional, self-hosted WhatsApp Web QR bridge.
-- The QR grants access to a linked device: never expose it through public RLS.

CREATE TABLE IF NOT EXISTS whatsapp_bridge_sessions (
    agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    state text NOT NULL DEFAULT 'offline'
        CHECK (state IN ('connecting', 'qr', 'connected', 'offline', 'logged_out')),
    qr_image text,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    last_error text
);

ALTER TABLE whatsapp_bridge_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_bridge_sessions FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS whatsapp_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    recipient_id text NOT NULL,
    body text NOT NULL,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    state text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'processing', 'sent', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz,
    sent_at timestamptz,
    provider_message_id text,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_outbox FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_ready
    ON whatsapp_outbox(agent_id, next_attempt_at, created_at)
    WHERE state = 'pending';
