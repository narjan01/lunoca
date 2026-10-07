-- =======================================================
-- LUNOCA DOCERIA - Plug-in Mercado Pago Schema Migration
-- =======================================================

-- 1. Colunas para integração do Mercado Pago na tabela 'pedidos'
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mercado_pago_id TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mercado_pago_status TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mercado_pago_preference_id TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mercado_pago_link TEXT;

-- 2. Índices para agilizar consultas de webhook e conciliação
CREATE INDEX IF NOT EXISTS idx_pedidos_mercado_pago_id ON public.pedidos(mercado_pago_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_mercado_pago_preference_id ON public.pedidos(mercado_pago_preference_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_mercado_pago_status ON public.pedidos(mercado_pago_status);

COMMENT ON COLUMN public.pedidos.mercado_pago_id IS 'ID oficial da transação de pagamento no Mercado Pago';
COMMENT ON COLUMN public.pedidos.mercado_pago_status IS 'Status da transação no Mercado Pago: approved, pending, in_process, rejected';
COMMENT ON COLUMN public.pedidos.mercado_pago_preference_id IS 'ID da preferência gerada pelo Checkout Pro';
COMMENT ON COLUMN public.pedidos.mercado_pago_link IS 'URL direta de checkout gerada pelo Mercado Pago';
