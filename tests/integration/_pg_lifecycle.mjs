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
  if (process.platform === 'win32') {
    if (pid) {
      try {
        execSync(`taskkill /pid ${pid} /f /t`, { stdio: 'ignore', timeout: 5000 });
      } catch {}
    }
    // Erradica qualquer processo filho postgres.exe que tenha ficado órfão em estado Suspenso (64 KB)
    // durante CreateProcess (CREATE_SUSPENDED) no momento do encerramento do postmaster:
    try {
      execSync(`taskkill /f /im postgres.exe /fi "MEMUSAGE lt 4096"`, { stdio: 'ignore', timeout: 5000 });
    } catch {}
  } else if (pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
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
  forceKillPid(null);
  cleanupDir(pgDir);

  const embedded = new EmbeddedPostgres({
    databaseDir: pgDir,
    user: 'postgres',
    password: 'postgres',
    port: actualPort,
    // Usamos persistent: true para impedir que embedded.stop() chame fs.rm() sem retry no Windows
    // (causando EBUSY no AsyncExitHook); a remoção do diretório é feita com retry por cleanupDir(pgDir)
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // Desativa autovacuum e processos auxiliares desnecessários nos testes para evitar
    // que o postmaster invoque CreateProcess(CREATE_SUSPENDED) durante o teardown no Windows
    postgresFlags: [
      '-c', 'autovacuum=off',
      '-c', 'max_wal_senders=0',
      '-c', 'fsync=off',
      '-c', 'synchronous_commit=off',
      '-c', 'full_page_writes=off',
    ],
    onLog: () => {},
    onError: () => {},
  });

  // Handler de emergência em caso de crash do processo do Node
  const emergencyKill = () => {
    if (embedded?.process?.pid) {
      forceKillPid(embedded.process.pid);
    } else {
      forceKillPid(null);
    }
  };

  process.once('exit', emergencyKill);
  process.once('SIGINT', emergencyKill);
  process.once('SIGTERM', emergencyKill);

  await embedded.initialise();
  await embedded.start();

  // Drena stdout do processo filho para evitar bloqueio de buffer de pipe no Windows
  if (embedded.process?.stdout) {
    embedded.process.stdout.on('data', () => {});
    embedded.process.stdout.resume();
  }

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

    // 2. Fecha conexões normais em paralelo sem prender o event loop
    const closeClient = (c) => {
      if (!c) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, 800);
        if (typeof timer.unref === 'function') timer.unref();
        c.end().then(resolve, resolve).finally(() => clearTimeout(timer));
      });
    };

    await Promise.allSettled(activeClients.map(closeClient));

    // 3. Fecha admin client
    if (adminClient) {
      await closeClient(adminClient);
    }

    // 4. Encerra EmbeddedPostgres com destruição explícita de stdio pipes e kill síncrono da árvore
    if (embedded) {
      const proc = embedded.process;
      const pid = proc?.pid;

      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            try {
              proc?.stdout?.destroy();
              proc?.stderr?.destroy();
              proc?.stdin?.destroy();
              if (typeof proc?.unref === 'function') proc.unref();
            } catch {}
            embedded.process = undefined;
            forceKillPid(pid);
            resolve();
          }
        };

        const timer = setTimeout(finish, 2500);
        if (typeof timer.unref === 'function') timer.unref();

        embedded.stop().then(finish).catch(finish);
      });
    } else {
      forceKillPid(null);
    }

    // 5. Limpa diretório de dados do cluster
    cleanupDir(pgDir);
  };

  return { connInfo, embedded, teardown };
}
