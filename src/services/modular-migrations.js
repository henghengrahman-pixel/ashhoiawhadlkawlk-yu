import {brainPool,pool} from '../db.js';
export async function migrateModularFeatures(){
  await brainPool.query(`
    ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS content_hash TEXT;
    ALTER TABLE ai_rules ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'GENERAL';
    ALTER TABLE ai_rules ADD COLUMN IF NOT EXISTS conditions JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE ai_rules ADD COLUMN IF NOT EXISTS action JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE ai_rules ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 100;
    ALTER TABLE ai_rules ADD COLUMN IF NOT EXISTS stop_processing BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE ai_rules ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE ai_rules ADD COLUMN IF NOT EXISTS content_hash TEXT;
    ALTER TABLE bot_important_info ADD COLUMN IF NOT EXISTS content_hash TEXT;
    ALTER TABLE bot_promo_rules ADD COLUMN IF NOT EXISTS content_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_content_hash ON knowledge_base(content_hash) WHERE content_hash IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_rules_content_hash ON ai_rules(content_hash) WHERE content_hash IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_important_content_hash ON bot_important_info(content_hash) WHERE content_hash IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_supplies_content_hash ON bot_promo_rules(content_hash) WHERE content_hash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS bot_manual_responses(
      id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,intent TEXT NOT NULL DEFAULT 'GENERAL',trigger_text TEXT,
      response_text TEXT NOT NULL,priority INT NOT NULL DEFAULT 100,enabled BOOLEAN NOT NULL DEFAULT true,notes TEXT,
      content_hash TEXT UNIQUE NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_bot_manual_responses_retrieval ON bot_manual_responses(enabled,intent,priority DESC,updated_at DESC);
  `);
  await pool.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handling_state TEXT NOT NULL DEFAULT 'AI_ACTIVE';
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS conversation_id TEXT;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_id TEXT;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_generation INT NOT NULL DEFAULT 0;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS livechat_activity_at TIMESTAMPTZ;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_livechat_event_at TIMESTAMPTZ;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_member_message_at TIMESTAMPTZ;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_bot_message_at TIMESTAMPTZ;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS close_reason TEXT;
    UPDATE conversations SET
      conversation_id=COALESCE(NULLIF(conversation_id,''),'conv:'||chat_id),
      session_id=COALESCE(NULLIF(session_id,''),'session:'||chat_id||':'||COALESCE(NULLIF(session_key,''),'legacy')),
      livechat_activity_at=COALESCE(livechat_activity_at,last_event_at,updated_at),
      last_livechat_event_at=COALESCE(last_livechat_event_at,last_event_at),
      last_member_message_at=COALESCE(last_member_message_at,last_member_event_at),
      last_bot_message_at=COALESCE(last_bot_message_at,last_ai_event_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_conversation_id ON conversations(conversation_id) WHERE conversation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_livechat_activity ON conversations(visible_in_inbox,lc_inbox_rank,livechat_activity_at DESC,chat_id);

    CREATE TABLE IF NOT EXISTS conversation_sessions(
      session_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      chat_id TEXT NOT NULL REFERENCES conversations(chat_id) ON DELETE CASCADE,
      session_key TEXT NOT NULL,
      livechat_chat_id TEXT NOT NULL,
      thread_id TEXT,
      generation INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      lc_active BOOLEAN NOT NULL DEFAULT true,
      visible_in_inbox BOOLEAN NOT NULL DEFAULT true,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ,
      close_reason TEXT,
      last_member_message_at TIMESTAMPTZ,
      last_bot_message_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(chat_id,session_key)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_sessions_active ON conversation_sessions(status,lc_active,visible_in_inbox,updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversation_sessions_chat_generation ON conversation_sessions(chat_id,generation DESC);
    INSERT INTO conversation_sessions(session_id,conversation_id,chat_id,session_key,livechat_chat_id,thread_id,generation,status,lc_active,visible_in_inbox,started_at,ended_at,close_reason,last_member_message_at,last_bot_message_at)
    SELECT c.session_id,c.conversation_id,c.chat_id,COALESCE(NULLIF(c.session_key,''),'legacy:'||c.chat_id),c.chat_id,c.current_thread_id,c.session_generation,
      CASE WHEN c.status='closed' OR c.lc_active=false THEN 'CLOSED' ELSE 'ACTIVE' END,
      COALESCE(c.lc_active,c.status<>'closed'),c.visible_in_inbox,c.created_at,c.ended_at,c.close_reason,c.last_member_message_at,c.last_bot_message_at
    FROM conversations c WHERE c.session_id IS NOT NULL
    ON CONFLICT(chat_id,session_key) DO UPDATE SET
      thread_id=COALESCE(EXCLUDED.thread_id,conversation_sessions.thread_id),generation=GREATEST(conversation_sessions.generation,EXCLUDED.generation),
      status=EXCLUDED.status,lc_active=EXCLUDED.lc_active,visible_in_inbox=EXCLUDED.visible_in_inbox,ended_at=EXCLUDED.ended_at,
      close_reason=EXCLUDED.close_reason,last_member_message_at=EXCLUDED.last_member_message_at,last_bot_message_at=EXCLUDED.last_bot_message_at,updated_at=now();

    ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS session_id TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS livechat_event_id TEXT;
    UPDATE messages m SET
      conversation_id=COALESCE(NULLIF(m.conversation_id,''),c.conversation_id,'conv:'||m.chat_id),
      session_id=COALESCE(NULLIF(m.session_id,''),'session:'||m.chat_id||':'||COALESCE(NULLIF(m.session_key,''),'legacy')),
      livechat_event_id=COALESCE(NULLIF(m.livechat_event_id,''),m.event_id)
    FROM conversations c WHERE c.chat_id=m.chat_id AND (m.conversation_id IS NULL OR m.session_id IS NULL OR m.livechat_event_id IS NULL);
    CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id,created_at,id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_livechat_event ON messages(chat_id,livechat_event_id) WHERE livechat_event_id IS NOT NULL;

    ALTER TABLE customer_event_processing ALTER COLUMN status SET DEFAULT 'PENDING';
    ALTER TABLE customer_event_processing ADD COLUMN IF NOT EXISTS session_id TEXT;
    ALTER TABLE customer_event_processing ADD COLUMN IF NOT EXISTS batch_id TEXT;
    ALTER TABLE customer_event_processing ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS idx_customer_event_processing_ready ON customer_event_processing(status,available_at,updated_at);
    CREATE INDEX IF NOT EXISTS idx_customer_event_processing_session ON customer_event_processing(session_id,status,created_at);

    ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS session_id TEXT;
    ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS source_event_id TEXT;
    ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS action TEXT;
    ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS last_error TEXT;
    ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_idempotency_key ON outbound_messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_outbound_source_event ON outbound_messages(chat_id,source_event_id,created_at DESC);

    ALTER TABLE human_bridge_tickets ADD COLUMN IF NOT EXISTS session_id TEXT;
    ALTER TABLE conversation_archives ADD COLUMN IF NOT EXISTS session_id TEXT;
    ALTER TABLE conversation_archives ADD COLUMN IF NOT EXISTS conversation_id TEXT;

    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_handling_state_check;
    ALTER TABLE conversations ADD CONSTRAINT conversations_handling_state_check CHECK (handling_state IN ('AI_ACTIVE','HUMAN_TAKEOVER','WAITING_TELEGRAM','PROCESSING','CLOSED'));
    CREATE INDEX IF NOT EXISTS idx_conversations_active_state ON conversations(visible_in_inbox,handling_state,last_event_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_inbox_order ON conversations(visible_in_inbox,lc_inbox_rank, last_event_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_id_desc ON messages(chat_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_human_requests_status_updated ON human_requests(status,updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bridge_tickets_status_updated ON human_bridge_tickets(status,updated_at DESC);
    CREATE TABLE IF NOT EXISTS content_collection_meta(
      collection_type TEXT PRIMARY KEY,version BIGINT NOT NULL DEFAULT 1,record_count BIGINT NOT NULL DEFAULT 0,
      checksum TEXT,last_updated TIMESTAMPTZ,last_synced TIMESTAMPTZ,source TEXT NOT NULL DEFAULT 'database'
    );
    CREATE TABLE IF NOT EXISTS content_import_history(
      id BIGSERIAL PRIMARY KEY,collection_type TEXT NOT NULL,file_name TEXT,uploaded INT NOT NULL DEFAULT 0,
      added INT NOT NULL DEFAULT 0,duplicate_skipped INT NOT NULL DEFAULT 0,invalid INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL,details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS logic_conflicts(
      id BIGSERIAL PRIMARY KEY,fingerprint TEXT UNIQUE NOT NULL,source_a TEXT NOT NULL,source_a_id TEXT,
      source_b TEXT NOT NULL,source_b_id TEXT,reason TEXT NOT NULL,severity TEXT NOT NULL,recommendation TEXT,
      status TEXT NOT NULL DEFAULT 'UNRESOLVED',detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),resolved_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS admin_audit_log(
      id BIGSERIAL PRIMARY KEY,actor TEXT NOT NULL DEFAULT 'admin',action TEXT NOT NULL,resource TEXT,
      resource_id TEXT,request_id TEXT,meta JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
