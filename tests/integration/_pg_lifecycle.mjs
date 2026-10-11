// ==========================================================================
// LUNOCA - CICLO DE VIDA ROBUSTO DE POSTGRESQL PARA TESTES DE INTEGRAÇÃO
// ==========================================================================
// Garante inicialização isolada, portas exclusivas, timeout fail-safe em shutdown,
// erradicação de processos filhos órfãos (Windows/Linux) e limpeza de disco.
// ==========================================================================

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execSync } from 'node:child_process';

function forceKillPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /f /t`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {}
}

export function cleanupDir(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch {
      // Aguarda 150ms de forma síncrona para liberação de handles no Windows NTFS
      const end = Date.now() + 150;
      while (Date.now() < end) {}
    }
  }
}

export async function getAvailablePort(preferredPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      const ephemeral = net.createServer();
      ephemeral.unref();
      ephemeral.listen(0, () => {
        const assigned = ephemeral.address().port;
        ephemeral.close(() => resolve(assigned));
      });
    });
    server.listen(preferredPort, () => {
      server.close(() => resolve(preferredPort));
    });
  });
}

export async function setupEmbeddedPostgres({ rootDir, dirName, port, dbName }) {
  if (process.env.DATABASE_URL) {
    return {
      connInfo: { connectionString: process.env.DATABASE_URL },
      embedded: null,
      teardown: async () => {}
    };
  }

  const actualPort = await getAvailablePort(port);
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const pgDir = path.join(rootDir, dirName);

  // Limpeza de qualquer resíduo prévio
  cleanupDir(pgDir);

  const embedded = new EmbeddedPostgres({
    databaseDir: pgDir,
    user: 'postgres',
    password: 'postgres',
    port: actualPort,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: () => {},
  });

  // Handler de emergência em caso de crash do processo do Node
  const emergencyKill = () => {
    if (embedded?.process?.pid) {
      forceKillPid(embedded.process.pid);
    }
  };

  process.once('exit', emergencyKill);
  process.once('SIGINT', emergencyKill);
  process.once('SIGTERM', emergencyKill);

  await embedded.initialise();
  await embedded.start();
  await embedded.createDatabase(dbName);

  const connInfo = {
    host: 'localhost',
    port: actualPort,
    user: 'postgres',
    password: 'postgres',
    database: dbName,
  };

  const teardown = async (activeClients = [], adminClient = null) => {
    // 1. Remove listeners de emergência
    process.removeListener('exit', emergencyKill);
    process.removeListener('SIGINT', emergencyKill);
    process.removeListener('SIGTERM', emergencyKill);

    // 2. Fecha conexões normais (timeout de 1s para cada)
    for (const c of activeClients) {
      try {
        await Promise.race([
          c.end(),
          new Promise((r) => setTimeout(r, 1000))
        ]);
      } catch {}
    }

    // 3. Fecha admin client
    if (adminClient) {
      try {
        await Promise.race([
          adminClient.end(),
          new Promise((r) => setTimeout(r, 1000))
        ]);
      } catch {}
    }

    // 4. Encerra EmbeddedPostgres com timeout fail-safe de 4 segundos
    if (embedded) {
      const pid = embedded.process?.pid;
      try {
        await Promise.race([
          embedded.stop(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('stop_timeout')), 4000))
        ]);
      } catch {
        forceKillPid(pid);
      }
    }

    // 5. Limpa diretório de dados do cluster
    cleanupDir(pgDir);
  };

  return { connInfo, embedded, teardown };
}
