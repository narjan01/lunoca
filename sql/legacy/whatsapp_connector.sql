-- =======================================================
-- LUNOCA DOCERIA - Migração do Conector WhatsApp
-- =======================================================

-- 1. Colunas para registro do WhatsApp nos pedidos
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS telefone_cliente TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS whatsapp_notificado BOOLEAN DEFAULT false;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS ultimo_status_whatsapp TEXT;

-- 2. Índice para consultas rápidas por telefone
CREATE INDEX IF NOT EXISTS idx_pedidos_telefone_cliente ON public.pedidos(telefone_cliente);

COMMENT ON COLUMN public.pedidos.telefone_cliente IS 'Telefone / WhatsApp informado pelo cliente no checkout';
COMMENT ON COLUMN public.pedidos.whatsapp_notificado IS 'Flag indicando se a última notificação de status foi disparada com sucesso';
COMMENT ON COLUMN public.pedidos.ultimo_status_whatsapp IS 'Último status de pedido enviado via WhatsApp';
