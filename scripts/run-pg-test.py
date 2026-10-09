import os
import sys
import time
import shutil
import subprocess
import ctypes
from ctypes import wintypes

advapi32 = ctypes.WinDLL('advapi32', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

kernel32.GetCurrentProcess.restype = wintypes.HANDLE
advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
advapi32.OpenProcessToken.restype = wintypes.BOOL
advapi32.CreateRestrictedToken.argtypes = [
    wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
    wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p,
    ctypes.POINTER(wintypes.HANDLE)
]
advapi32.CreateRestrictedToken.restype = wintypes.BOOL

class STARTUPINFO(ctypes.Structure):
    _fields_ = [
        ('cb', wintypes.DWORD), ('lpReserved', wintypes.LPWSTR), ('lpDesktop', wintypes.LPWSTR),
        ('lpTitle', wintypes.LPWSTR), ('dwX', wintypes.DWORD), ('dwY', wintypes.DWORD),
        ('dwXSize', wintypes.DWORD), ('dwYSize', wintypes.DWORD), ('dwXCountChars', wintypes.DWORD),
        ('dwYCountChars', wintypes.DWORD), ('dwFillAttribute', wintypes.DWORD), ('dwFlags', wintypes.DWORD),
        ('wShowWindow', wintypes.WORD), ('cbReserved2', wintypes.WORD), ('lpReserved2', ctypes.c_char_p),
        ('hStdInput', wintypes.HANDLE), ('hStdOutput', wintypes.HANDLE), ('hStdError', wintypes.HANDLE)
    ]

class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('hProcess', wintypes.HANDLE), ('hThread', wintypes.HANDLE),
        ('dwProcessId', wintypes.DWORD), ('dwThreadId', wintypes.DWORD)
    ]

advapi32.CreateProcessAsUserW.argtypes = [
    wintypes.HANDLE, wintypes.LPCWSTR, wintypes.LPWSTR,
    ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL,
    wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
    ctypes.POINTER(STARTUPINFO), ctypes.POINTER(PROCESS_INFORMATION)
]
advapi32.CreateProcessAsUserW.restype = wintypes.BOOL

TOKEN_ALL_ACCESS = 0xF01FF
DISABLE_MAX_PRIVILEGE = 0x1

def get_restricted_token():
    hToken = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), TOKEN_ALL_ACCESS, ctypes.byref(hToken)):
        raise RuntimeError(f"OpenProcessToken failed: {ctypes.get_last_error()}")
    hRestricted = wintypes.HANDLE()
    if not advapi32.CreateRestrictedToken(hToken, DISABLE_MAX_PRIVILEGE, 0, None, 0, None, 0, None, ctypes.byref(hRestricted)):
        raise RuntimeError(f"CreateRestrictedToken failed: {ctypes.get_last_error()}")
    return hRestricted

def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    pg_bin = os.path.join(root, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin')
    data_dir = os.path.join(root, '.pg-test-instance')
    port = 54329

    if os.path.exists(data_dir):
        try:
            shutil.rmtree(data_dir)
        except Exception:
            pass

    print("[runner] 1. Inicializando cluster PostgreSQL com initdb...")
    initdb = os.path.join(pg_bin, 'initdb.exe')
    res = subprocess.run([initdb, '-D', data_dir, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8'], capture_output=True, text=True)
    if res.returncode != 0:
        print("[runner] ERRO no initdb:", res.stderr)
        sys.exit(1)

    print("[runner] 2. Iniciando postgres.exe com token restrito (desprivilegiado)...")
    hRestricted = get_restricted_token()
    si = STARTUPINFO()
    si.cb = ctypes.sizeof(STARTUPINFO)
    pi = PROCESS_INFORMATION()
    pg_ctl = os.path.join(pg_bin, 'pg_ctl.exe')
    log_file = os.path.join(root, 'pg.log')
    cmd = f'"{pg_ctl}" -D "{data_dir}" -l "{log_file}" -o "-p {port}" start'
    CREATE_NO_WINDOW = 0x08000000
    ok = advapi32.CreateProcessAsUserW(hRestricted, None, cmd, None, None, False, CREATE_NO_WINDOW, None, None, ctypes.byref(si), ctypes.byref(pi))
    if not ok:
        print("[runner] ERRO ao criar processo pg_ctl.exe:", ctypes.get_last_error())
        sys.exit(1)

    kernel32.WaitForSingleObject(pi.hProcess, 5000)
    print(f"[runner] pg_ctl start executado.")

    try:
        # aguardar inicialização via socket
        import socket
        ready = False
        for i in range(30):
            time.sleep(0.5)
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=1):
                    ready = True
                    break
            except (OSError, ConnectionRefusedError):
                pass
        
        if not ready:
            print("[runner] ERRO: Postgres nao respondeu em 15 segundos.")
            if os.path.exists(log_file):
                with open(log_file, 'r', errors='ignore') as f:
                    print("[runner] Conteudo de pg.log:\n", f.read())
            sys.exit(1)

        print("[runner] 3. Postgres pronto! Criando banco lunoca_test via node...")
        init_db_script = f"""
        import pg from 'pg';
        const client = new pg.Client({{ host: '127.0.0.1', port: {port}, user: 'postgres', database: 'postgres' }});
        await client.connect();
        const {{ rows }} = await client.query("SELECT 1 FROM pg_database WHERE datname = 'lunoca_test'");
        if (rows.length === 0) {{
          await client.query("CREATE DATABASE lunoca_test");
        }}
        await client.end();
        console.log('Banco lunoca_test pronto!');
        """
        init_res = subprocess.run(['node', '--input-type=module', '-e', init_db_script], cwd=root, capture_output=True, text=True)
        if init_res.returncode != 0:
            print("[runner] Erro ao criar banco:", init_res.stderr)
            sys.exit(1)
        print("[runner]", init_res.stdout.strip())

        db_url = f"postgres://postgres:postgres@127.0.0.1:{port}/lunoca_test"
        print(f"[runner] 4. Executando testes de integracao com DATABASE_URL={db_url}...")
        env = dict(os.environ)
        env['DATABASE_URL'] = db_url

        test_files = sys.argv[1:] if len(sys.argv) > 1 else [
            'tests/integration/etapa2.integration.test.mjs',
            'tests/integration/etapa3.integration.test.mjs'
        ]
        test_cmd = ['node', '--test', '--test-concurrency=1', '--test-reporter=spec'] + test_files
        test_res = subprocess.run(test_cmd, cwd=root, env=env)
        print(f"\n[runner] 5. Testes concluidos com codigo de saida: {test_res.returncode}")
        sys.exit(test_res.returncode)

    finally:
        print("[runner] 6. Encerrando servidor Postgres...")
        try:
            subprocess.run([pg_ctl, '-D', data_dir, '-m', 'immediate', 'stop'], capture_output=True)
        except Exception:
            pass
        if pi.hProcess:
            try:
                kernel32.TerminateProcess(pi.hProcess, 0)
                kernel32.CloseHandle(pi.hProcess)
                kernel32.CloseHandle(pi.hThread)
            except Exception:
                pass
        time.sleep(1)
        try:
            shutil.rmtree(data_dir)
        except Exception:
            pass
        print("[runner] Servidor encerrado e diretorio limpo.")

if __name__ == '__main__':
    main()
