/*
 * appcontainer-launcher.exe
 *
 * Minimal Win32 console helper that creates/launches/destroys Windows
 * AppContainer profiles on behalf of the OpenClaw TypeScript runtime.
 *
 * Build (MSVC):
 *   cl /nologo /W4 /O2 /MT main.c /link userenv.lib advapi32.lib kernel32.lib
 *
 * Build (MinGW-w64 / GCC):
 *   gcc -O2 -municode -DUNICODE -D_UNICODE -Wall -o appcontainer-launcher.exe \
 *       main.c -lkernel32 -ladvapi32 -luserenv
 *
 * All output is one JSON line to stdout (success) or stderr (error).
 * Exit code 0 = success, 1 = error.
 *
 * Verbs:
 *   create  --name <n> --display <d>
 *   launch  --sid <s> --program <p> [--arg <a>]... [--env K=V]... [--cwd <d>] [--cap <sid>]...
 *   destroy --name <n>
 *   check   --name <n>
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* MinGW may not define these — define them if missing */
#ifndef PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES
#define ProcThreadAttributeSecurityCapabilities 9
#define PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES \
    ProcThreadAttributeValue(ProcThreadAttributeSecurityCapabilities, FALSE, TRUE, FALSE)
#endif

#ifndef EXTENDED_STARTUPINFO_PRESENT
#define EXTENDED_STARTUPINFO_PRESENT 0x00080000
#endif

/* ---------- helpers --------------------------------------------------- */

static void write_stdout(const char *json) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), json, (DWORD)strlen(json), &written, NULL);
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "\n", 1, &written, NULL);
}

static void write_stderr_str(const char *msg) {
    DWORD written;
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), msg, (DWORD)strlen(msg), &written, NULL);
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), "\n", 1, &written, NULL);
}

static void fail(const char *msg) {
    char buf[1024];
    snprintf(buf, sizeof(buf), "{\"error\":\"%s\"}", msg);
    write_stderr_str(buf);
    ExitProcess(1);
}

static void fail_win32(const char *context) {
    char buf[1024];
    DWORD err = GetLastError();
    snprintf(buf, sizeof(buf), "{\"error\":\"%s: Win32 error %lu\"}", context, (unsigned long)err);
    write_stderr_str(buf);
    ExitProcess(1);
}

/* Wide-char argv from wmain */
static int    g_argc = 0;
static LPWSTR *g_argv = NULL;

static const WCHAR *get_flag(const WCHAR *name) {
    for (int i = 2; i < g_argc - 1; i++) {
        if (wcscmp(g_argv[i], name) == 0) {
            return g_argv[i + 1];
        }
    }
    return NULL;
}

/* Convert wide string to narrow UTF-8 (heap allocated). */
static char *wide_to_utf8(const WCHAR *w) {
    if (!w) return NULL;
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (n <= 0) return NULL;
    char *buf = (char *)malloc((size_t)n);
    if (!buf) return NULL;
    WideCharToMultiByte(CP_UTF8, 0, w, -1, buf, n, NULL, NULL);
    return buf;
}

/* Escape a string for JSON (escapes backslash and double-quote). */
static void json_escape(const char *s, char *out, size_t outlen) {
    size_t j = 0;
    for (size_t i = 0; s[i] && j + 3 < outlen; i++) {
        if (s[i] == '\\' || s[i] == '"') {
            out[j++] = '\\';
        }
        out[j++] = (unsigned char)s[i];
    }
    out[j] = '\0';
}

/* ---------- verb: create ---------------------------------------------- */

static void verb_create(void) {
    const WCHAR *name_w    = get_flag(L"--name");
    const WCHAR *display_w = get_flag(L"--display");

    if (!name_w)    fail("--name required for create");
    if (!display_w) fail("--display required for create");

    PSID sid = NULL;
    HRESULT hr = CreateAppContainerProfile(
        name_w, display_w, display_w, NULL, 0, &sid);

    /* HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS) = 0x800700B7 */
    if (hr == (HRESULT)0x800700B7) {
        hr = DeriveAppContainerSidFromAppContainerName(name_w, &sid);
        if (FAILED(hr)) fail_win32("DeriveAppContainerSidFromAppContainerName");
    } else if (FAILED(hr)) {
        char errbuf[64];
        snprintf(errbuf, sizeof(errbuf),
            "CreateAppContainerProfile: hr=0x%08lX", (unsigned long)(DWORD)hr);
        fail(errbuf);
    }

    LPWSTR sid_str = NULL;
    if (!ConvertSidToStringSidW(sid, &sid_str)) {
        FreeSid(sid);
        fail_win32("ConvertSidToStringSidW");
    }

    char *sid_utf8  = wide_to_utf8(sid_str);
    char *name_utf8 = wide_to_utf8(name_w);
    LocalFree(sid_str);
    FreeSid(sid);

    char sid_esc[256], name_esc[512];
    json_escape(sid_utf8  ? sid_utf8  : "", sid_esc,  sizeof(sid_esc));
    json_escape(name_utf8 ? name_utf8 : "", name_esc, sizeof(name_esc));
    free(sid_utf8); free(name_utf8);

    char out[1024];
    snprintf(out, sizeof(out), "{\"sid\":\"%s\",\"name\":\"%s\"}", sid_esc, name_esc);
    write_stdout(out);
}

/* ---------- verb: check ----------------------------------------------- */

static void verb_check(void) {
    const WCHAR *name_w = get_flag(L"--name");
    if (!name_w) fail("--name required for check");

    PSID sid = NULL;
    HRESULT hr = DeriveAppContainerSidFromAppContainerName(name_w, &sid);
    if (FAILED(hr)) {
        write_stdout("{\"exists\":false}");
        return;
    }

    LPWSTR sid_str = NULL;
    if (!ConvertSidToStringSidW(sid, &sid_str)) {
        FreeSid(sid);
        fail_win32("ConvertSidToStringSidW");
    }

    char *sid_utf8 = wide_to_utf8(sid_str);
    LocalFree(sid_str);
    FreeSid(sid);

    char sid_esc[256];
    json_escape(sid_utf8 ? sid_utf8 : "", sid_esc, sizeof(sid_esc));
    free(sid_utf8);

    char out[512];
    snprintf(out, sizeof(out), "{\"exists\":true,\"sid\":\"%s\"}", sid_esc);
    write_stdout(out);
}

/* ---------- verb: destroy --------------------------------------------- */

static void verb_destroy(void) {
    const WCHAR *name_w = get_flag(L"--name");
    if (!name_w) fail("--name required for destroy");

    HRESULT hr = DeleteAppContainerProfile(name_w);
    /* HRESULT_FROM_WIN32(ERROR_NOT_FOUND) = 0x80070490 */
    if (FAILED(hr) && hr != (HRESULT)0x80070490) {
        char errbuf[64];
        snprintf(errbuf, sizeof(errbuf),
            "DeleteAppContainerProfile: hr=0x%08lX", (unsigned long)(DWORD)hr);
        fail(errbuf);
    }
    write_stdout("{\"ok\":true}");
}

/* ---------- verb: launch ---------------------------------------------- */

#define MAX_CAPS 16

static void verb_launch(void) {
    const WCHAR *sid_str_w = get_flag(L"--sid");
    const WCHAR *program_w = get_flag(L"--program");

    if (!sid_str_w) fail("--sid required for launch");
    if (!program_w) fail("--program required for launch");

    /* Parse capability SIDs from --cap flags */
    PSID cap_sids[MAX_CAPS];
    SID_AND_ATTRIBUTES caps[MAX_CAPS];
    int cap_count = 0;

    for (int i = 2; i < g_argc - 1 && cap_count < MAX_CAPS; i++) {
        if (wcscmp(g_argv[i], L"--cap") == 0) {
            PSID s = NULL;
            if (!ConvertStringSidToSidW(g_argv[i + 1], &s)) {
                fail_win32("ConvertStringSidToSidW for --cap");
            }
            cap_sids[cap_count] = s;
            caps[cap_count].Sid = s;
            caps[cap_count].Attributes = SE_GROUP_ENABLED;
            cap_count++;
        }
    }

    /* Build command line: "program" "arg1" "arg2" ... */
    WCHAR cmdline[32768];
    cmdline[0] = L'\0';
    wcsncat(cmdline, L"\"", 32768 - wcslen(cmdline) - 1);
    wcsncat(cmdline, program_w, 32768 - wcslen(cmdline) - 1);
    wcsncat(cmdline, L"\"", 32768 - wcslen(cmdline) - 1);

    for (int i = 2; i < g_argc - 1; i++) {
        if (wcscmp(g_argv[i], L"--arg") == 0) {
            wcsncat(cmdline, L" \"", 32768 - wcslen(cmdline) - 1);
            wcsncat(cmdline, g_argv[i + 1], 32768 - wcslen(cmdline) - 1);
            wcsncat(cmdline, L"\"", 32768 - wcslen(cmdline) - 1);
        }
    }

    /* Build environment block: KEY=VALUE\0KEY=VALUE\0\0 */
    WCHAR envblock[65536];
    WCHAR *ep = envblock;
    size_t remaining = sizeof(envblock)/sizeof(WCHAR);

    for (int i = 2; i < g_argc - 1; i++) {
        if (wcscmp(g_argv[i], L"--env") == 0) {
            size_t len = wcslen(g_argv[i + 1]);
            if (len + 2 < remaining) {
                wcsncpy(ep, g_argv[i + 1], len + 1);
                ep += len + 1;
                remaining -= len + 1;
            }
        }
    }
    *ep = L'\0';  /* double-null terminator */
    BOOL use_env = (ep != envblock);

    const WCHAR *cwd_w = get_flag(L"--cwd");

    /* Container SID */
    PSID container_sid = NULL;
    if (!ConvertStringSidToSidW(sid_str_w, &container_sid)) {
        fail_win32("ConvertStringSidToSidW for --sid");
    }

    /* Security capabilities */
    SECURITY_CAPABILITIES sc;
    memset(&sc, 0, sizeof(sc));
    sc.AppContainerSid = container_sid;
    sc.Capabilities    = cap_count > 0 ? caps : NULL;
    sc.CapabilityCount = (DWORD)cap_count;

    /* Build PROC_THREAD_ATTRIBUTE_LIST */
    SIZE_T attr_size = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &attr_size);
    LPPROC_THREAD_ATTRIBUTE_LIST attr_list =
        (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attr_size);
    if (!attr_list) fail("HeapAlloc for attribute list failed");

    if (!InitializeProcThreadAttributeList(attr_list, 1, 0, &attr_size))
        fail_win32("InitializeProcThreadAttributeList");

    if (!UpdateProcThreadAttribute(
            attr_list, 0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            &sc, sizeof(sc), NULL, NULL))
        fail_win32("UpdateProcThreadAttribute");

    STARTUPINFOEXW si;
    memset(&si, 0, sizeof(si));
    si.StartupInfo.cb = sizeof(si);
    si.lpAttributeList = attr_list;

    PROCESS_INFORMATION pi;
    memset(&pi, 0, sizeof(pi));

    BOOL ok = CreateProcessW(
        program_w,
        cmdline,
        NULL, NULL,
        FALSE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE,
        use_env ? envblock : NULL,
        cwd_w,
        &si.StartupInfo,
        &pi
    );

    DeleteProcThreadAttributeList(attr_list);
    HeapFree(GetProcessHeap(), 0, attr_list);
    LocalFree(container_sid);
    for (int i = 0; i < cap_count; i++) LocalFree(cap_sids[i]);

    if (!ok) fail_win32("CreateProcessW");

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    char out[64];
    snprintf(out, sizeof(out), "{\"pid\":%lu}", (unsigned long)pi.dwProcessId);
    write_stdout(out);
}

/* ---------- main ------------------------------------------------------- */

int wmain(int argc, LPWSTR *argv) {
    g_argc = argc;
    g_argv = argv;

    if (argc < 2) {
        fail("Usage: appcontainer-launcher <create|launch|destroy|check> [options]");
    }

    if (wcscmp(argv[1], L"create")  == 0) { verb_create();  return 0; }
    if (wcscmp(argv[1], L"launch")  == 0) { verb_launch();  return 0; }
    if (wcscmp(argv[1], L"destroy") == 0) { verb_destroy(); return 0; }
    if (wcscmp(argv[1], L"check")   == 0) { verb_check();   return 0; }

    fail("Unknown verb. Expected: create, launch, destroy, check");
    return 1;
}
