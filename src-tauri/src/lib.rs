use std::{
    cell::RefCell,
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, ExitStatus},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(all(target_os = "macos", not(debug_assertions)))]
use std::os::unix::{fs::OpenOptionsExt, process::CommandExt};

#[cfg(all(target_os = "windows", not(debug_assertions)))]
use std::ffi::OsString;

#[cfg(any(target_os = "macos", target_os = "windows", not(debug_assertions)))]
use std::process::Stdio;

#[cfg(target_os = "windows")]
use std::{os::windows::io::AsRawHandle, os::windows::process::CommandExt};

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    },
    Networking::WinSock::AF_INET,
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            OpenProcess, QueryFullProcessImageNameW, CREATE_NO_WINDOW,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
    UI::Shell::SetCurrentProcessExplicitAppUserModelID,
};

#[cfg(not(debug_assertions))]
use std::net::{TcpListener, TcpStream};

use ed25519_dalek::{Signer, SigningKey};
use image::{GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous},
    Column, Connection, Row, SqliteConnection, TypeInfo, ValueRef,
};
use tauri::{Manager, WebviewUrl};

#[cfg(target_os = "macos")]
use objc2::{
    define_class, msg_send,
    rc::{Retained, Weak},
    runtime::{AnyObject, NSObjectProtocol},
    sel, DefinedClass, MainThreadMarker, MainThreadOnly,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplication, NSPrintInfo, NSPrintOperation, NSWindow};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSData, NSObject};
#[cfg(target_os = "macos")]
use objc2_pdf_kit::{PDFDocument, PDFPrintScalingMode};

#[cfg(target_os = "windows")]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM,
};
#[cfg(target_os = "windows")]
use windows::core::Interface;

const KEYCHAIN_SERVICE: &str = "com.bezgrow.erp";
#[cfg(not(debug_assertions))]
const NATIVE_BUILD_COMMIT: &str = env!("BEZGROW_BUILD_COMMIT");
#[cfg(not(debug_assertions))]
const NATIVE_BUILD_TIMESTAMP: &str = env!("BEZGROW_BUILD_TIMESTAMP");
const LOCAL_DATABASE_NAME: &str = "bezgrow-offline.db";
const WINDOWS_APP_DATA_DIR: &str = "Bezgrow";
const INSTALLATION_DIRECTORY: &str = "Installation";
const DEVICE_ID_FILENAME: &str = "device-id";
const INSTALLATION_SEED_FILENAME: &str = "installation-seed";
const PLATFORM_ADMIN_SIGNING_KEY_PREFIX: &str = "platform-admin-device-signing-key";
const PLATFORM_ADMIN_SIGNING_KEY_FILENAME: &str = "platform-admin-device-signing-key";
#[cfg(target_os = "macos")]
static PDF_PRINT_LIFECYCLE_ASSOCIATION_KEY: u8 = 0;
#[cfg(target_os = "macos")]
static ACTIVE_PDF_PRINT_SESSIONS: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "windows")]
const WINDOWS_APP_USER_MODEL_ID: &str = "com.bezgrow.erp";
const STARTUP_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;
const STARTUP_LOG_GENERATIONS: usize = 5;

#[cfg(target_os = "macos")]
struct PdfPrintLifecycleIvars {
    // AppKit may still have the operation on its callback stack when the
    // completion selector runs. Keep the graph in Options so a next-run-loop
    // finalizer can release it after the completion selector has returned.
    document: RefCell<Option<Retained<PDFDocument>>>,
    print_info: RefCell<Option<Retained<NSPrintInfo>>>,
    operation: RefCell<Option<Retained<NSPrintOperation>>>,
    window: Weak<NSWindow>,
    terminal: RefCell<&'static str>,
    completion_started: AtomicBool,
    cleanup_started: AtomicBool,
    session_id: String,
    log_path: PathBuf,
}

#[cfg(target_os = "macos")]
define_class!(
    // SAFETY:
    // - NSObject has no subclassing requirements.
    // - All retained AppKit/PDFKit objects and callbacks stay on the main thread.
    // - The generated ivar drop implementation releases the native print graph.
    #[unsafe(super(NSObject))]
    #[name = "BezgrowPDFPrintLifecycle"]
    #[thread_kind = MainThreadOnly]
    #[ivars = PdfPrintLifecycleIvars]
    struct PdfPrintLifecycle;

    unsafe impl NSObjectProtocol for PdfPrintLifecycle {}

    impl PdfPrintLifecycle {
        // SAFETY: This is the documented completion-selector signature for
        // NSPrintOperation::runOperationModalForWindow(...).
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn print_operation_did_run(
            &self,
            operation: &NSPrintOperation,
            success: bool,
            _context_info: *mut std::ffi::c_void,
        ) {
            let ivars = self.ivars();
            if ivars.completion_started.swap(true, Ordering::SeqCst) {
                append_pdf_print_lifecycle_log(
                    &ivars.log_path,
                    &ivars.session_id,
                    "Duplicate completion callback ignored",
                );
                return;
            }
            if let Some(retained_operation) = ivars.operation.borrow().as_ref() {
                debug_assert!(std::ptr::eq(operation, &**retained_operation));
            }
            append_pdf_print_lifecycle_log(
                &ivars.log_path,
                &ivars.session_id,
                if success {
                    "Completion callback entered; terminal=printed"
                } else {
                    "Cancel selected; Completion callback entered; terminal=cancelled"
                },
            );
            *ivars.terminal.borrow_mut() = if success { "printed" } else { "cancelled" };

            // Never release NSPrintOperation from inside its own completion
            // callback. NSObject schedules and retains this target until the
            // next main run-loop turn, after AppKit has unwound this stack.
            unsafe {
                let _: () = msg_send![
                    self,
                    performSelector: sel!(finishPrintLifecycle),
                    withObject: std::ptr::null::<AnyObject>(),
                    afterDelay: 0.0_f64
                ];
            }
            append_pdf_print_lifecycle_log(
                &ivars.log_path,
                &ivars.session_id,
                "Completion callback exited; cleanup scheduled",
            );
        }

        #[unsafe(method(finishPrintLifecycle))]
        fn finish_print_lifecycle(&self) {
            let ivars = self.ivars();
            if ivars.cleanup_started.swap(true, Ordering::SeqCst) {
                append_pdf_print_lifecycle_log(
                    &ivars.log_path,
                    &ivars.session_id,
                    "Duplicate cleanup ignored",
                );
                return;
            }

            let terminal = *ivars.terminal.borrow();

            if let Some(window) = ivars.window.load() {
                unsafe {
                    objc2::ffi::objc_setAssociatedObject(
                        (&*window as *const NSWindow).cast_mut().cast(),
                        (&PDF_PRINT_LIFECYCLE_ASSOCIATION_KEY as *const u8).cast(),
                        std::ptr::null_mut(),
                        objc2::ffi::OBJC_ASSOCIATION_ASSIGN,
                    );
                }
            }

            // Drop in dependency order while the scheduled selector still
            // retains `self`, but only after the AppKit callback has returned.
            ivars.operation.borrow_mut().take();
            ivars.print_info.borrow_mut().take();
            ivars.document.borrow_mut().take();
            let active = ACTIVE_PDF_PRINT_SESSIONS
                .fetch_sub(1, Ordering::SeqCst)
                .saturating_sub(1);
            append_pdf_print_lifecycle_log(
                &ivars.log_path,
                &ivars.session_id,
                format!("Objects released; active_sessions={active}"),
            );
            append_pdf_print_lifecycle_log(
                &ivars.log_path,
                &ivars.session_id,
                format!("Native print lifecycle completed; terminal={terminal}"),
            );
        }
    }
);

#[cfg(target_os = "macos")]
impl PdfPrintLifecycle {
    fn new(
        mtm: MainThreadMarker,
        document: Retained<PDFDocument>,
        print_info: Retained<NSPrintInfo>,
        operation: Retained<NSPrintOperation>,
        window: &NSWindow,
        session_id: String,
        log_path: PathBuf,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(PdfPrintLifecycleIvars {
            document: RefCell::new(Some(document)),
            print_info: RefCell::new(Some(print_info)),
            operation: RefCell::new(Some(operation)),
            window: Weak::new(window),
            terminal: RefCell::new("failed"),
            completion_started: AtomicBool::new(false),
            cleanup_started: AtomicBool::new(false),
            session_id,
            log_path,
        });
        // SAFETY: NSObject's initializer has the standard `init` signature.
        unsafe { msg_send![super(this), init] }
    }
}

#[cfg(target_os = "macos")]
fn append_pdf_print_lifecycle_log(path: &Path, session_id: &str, event: impl AsRef<str>) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let current_thread = thread::current();
    let thread_name = current_thread.name().unwrap_or("unnamed");
    let _ = writeln!(
        file,
        "[{timestamp_ms}] native-print session={session_id} thread={:?} thread_name={thread_name} {}",
        current_thread.id(),
        event.as_ref()
    );
}
#[cfg(not(debug_assertions))]
const DESKTOP_SERVER_PORT: u16 = 43124;
#[cfg(not(debug_assertions))]
const RUNTIME_DIRECTORY: &str = "Runtime";
#[cfg(not(debug_assertions))]
const RUNTIME_STATE_FILENAME: &str = "runtime.json";
#[cfg(not(debug_assertions))]
const RUNTIME_STATE_SCHEMA: u8 = 1;
#[cfg(not(debug_assertions))]
const LEGACY_CLEANUP_MARKER_FILENAME: &str = "legacy-runtime-cleanup-v1";
#[cfg(not(debug_assertions))]
const RUNTIME_HEALTH_PATH: &str = "/api/desktop-health";
#[cfg(not(debug_assertions))]
const RUNTIME_HEALTH_HEADER: &str = "X-Bezgrow-Runtime-Token";

#[cfg(target_os = "windows")]
struct WindowsProcessJob(HANDLE);

#[cfg(target_os = "windows")]
unsafe impl Send for WindowsProcessJob {}

#[cfg(target_os = "windows")]
impl Drop for WindowsProcessJob {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct NextServerProcess {
    child: Child,
    #[cfg(target_os = "windows")]
    _job: WindowsProcessJob,
    #[cfg(not(debug_assertions))]
    port: u16,
    #[cfg(not(debug_assertions))]
    ownership: RuntimeOwnership,
}

#[cfg(not(debug_assertions))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeOwnership {
    schema_version: u8,
    shell_pid: u32,
    shell_executable: String,
    server_pid: u32,
    server_process_group: Option<u32>,
    server_executable: String,
    server_entry: String,
    app_version: String,
    port: u16,
    token: String,
    started_at: String,
}

#[cfg(not(debug_assertions))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeHealth {
    status: String,
    runtime: String,
    #[serde(default)]
    app_version: Option<String>,
    #[serde(default)]
    shell_pid: Option<u32>,
    #[serde(default)]
    server_pid: Option<u32>,
}

struct NextServerState {
    process: Mutex<Option<NextServerProcess>>,
    startup: Mutex<()>,
    shutting_down: AtomicBool,
    #[cfg(not(debug_assertions))]
    supervisor_started: AtomicBool,
}

struct DesktopOperationState {
    active_critical_operations: AtomicUsize,
    update_preparing: AtomicBool,
}

impl DesktopOperationState {
    fn new() -> Self {
        Self {
            active_critical_operations: AtomicUsize::new(0),
            update_preparing: AtomicBool::new(false),
        }
    }
}

struct CriticalOperationGuard<'a>(tauri::State<'a, DesktopOperationState>);

impl Drop for CriticalOperationGuard<'_> {
    fn drop(&mut self) {
        self.0
            .active_critical_operations
            .fetch_sub(1, Ordering::SeqCst);
    }
}

fn begin_critical_operation<'a, R: tauri::Runtime>(
    app: &'a tauri::AppHandle<R>,
) -> Result<CriticalOperationGuard<'a>, String> {
    let state = app.state::<DesktopOperationState>();
    if state.update_preparing.load(Ordering::SeqCst) {
        return Err("Bezgrow is preparing a verified update. Finish or cancel the update before starting another write, print, backup, restore, migration, or export.".to_string());
    }
    state
        .active_critical_operations
        .fetch_add(1, Ordering::SeqCst);
    if state.update_preparing.load(Ordering::SeqCst) {
        state
            .active_critical_operations
            .fetch_sub(1, Ordering::SeqCst);
        return Err("Bezgrow started update preparation before this operation could begin. Try again after the update.".to_string());
    }
    Ok(CriticalOperationGuard(state))
}

#[cfg(target_os = "windows")]
fn windows_hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(target_os = "windows")]
fn assign_child_to_kill_on_close_job(child: &Child) -> Result<WindowsProcessJob, String> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(format!(
                "Unable to create the Windows process job: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &information as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            let error = std::io::Error::last_os_error();
            CloseHandle(job);
            return Err(format!(
                "Unable to configure the Windows process job: {error}"
            ));
        }

        if AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
            let error = std::io::Error::last_os_error();
            CloseHandle(job);
            return Err(format!(
                "Unable to attach the bundled server to the Windows process job: {error}"
            ));
        }

        Ok(WindowsProcessJob(job))
    }
}

#[cfg(target_os = "windows")]
fn configure_windows_app_identity() -> Result<(), String> {
    let mut identifier = WINDOWS_APP_USER_MODEL_ID.encode_utf16().collect::<Vec<_>>();
    identifier.push(0);
    let result = unsafe { SetCurrentProcessExplicitAppUserModelID(identifier.as_ptr()) };
    if result < 0 {
        return Err(format!(
            "Unable to set the Windows AppUserModelID: HRESULT 0x{:08x}",
            result as u32
        ));
    }
    Ok(())
}

impl NextServerState {
    fn new() -> Self {
        Self {
            process: Mutex::new(None),
            startup: Mutex::new(()),
            shutting_down: AtomicBool::new(false),
            #[cfg(not(debug_assertions))]
            supervisor_started: AtomicBool::new(false),
        }
    }
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        thread::sleep(Duration::from_millis(25));
    }
    None
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn process_group_exists(process_group: u32) -> bool {
    let result = unsafe { libc::kill(-(process_group as i32), 0) };
    result == 0 || std::io::Error::last_os_error().kind() == std::io::ErrorKind::PermissionDenied
}

fn terminate_child_process(
    child: &mut Child,
    #[cfg(not(debug_assertions))] process_group: Option<u32>,
) -> Option<ExitStatus> {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id().to_string();
        let _ = windows_hidden_command("taskkill.exe")
            .args(["/PID", &pid, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    if let Some(process_group) = process_group.filter(|group| *group == child.id()) {
        if process_group_exists(process_group) {
            unsafe {
                libc::kill(-(process_group as i32), libc::SIGTERM);
            }
            let status = child
                .try_wait()
                .ok()
                .flatten()
                .or_else(|| wait_for_child_exit(child, Duration::from_millis(1200)));
            if process_group_exists(process_group) {
                unsafe {
                    libc::kill(-(process_group as i32), libc::SIGKILL);
                }
            }
            if let Some(status) = status {
                return Some(status);
            }
        }
    }

    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
    child.wait().ok()
}

fn stop_next_server<R: tauri::Runtime>(app: &tauri::AppHandle<R>, cause: &str) {
    let Some(state) = app.try_state::<NextServerState>() else {
        return;
    };
    state.shutting_down.store(true, Ordering::SeqCst);

    let Some(mut process) = state
        .process
        .lock()
        .expect("next server state poisoned")
        .take()
    else {
        return;
    };

    let server_pid = process.child.id();
    let status = terminate_child_process(
        &mut process.child,
        #[cfg(not(debug_assertions))]
        process.ownership.server_process_group,
    );
    #[cfg(not(debug_assertions))]
    remove_runtime_state_if_owned(app, &process.ownership);
    append_startup_log_handle(
        app,
        format!(
            "Bundled runtime stopped. shell_pid={}, server_pid={server_pid}, cause={}, child_exit={}",
            std::process::id(),
            cause.replace(['\r', '\n'], " "),
            status
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
    );
}

fn wait_for_critical_operations<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(state) = app.try_state::<DesktopOperationState>() else {
        return;
    };
    state.update_preparing.store(true, Ordering::SeqCst);
    let started = std::time::Instant::now();
    while state.active_critical_operations.load(Ordering::SeqCst) != 0
        && started.elapsed() < Duration::from_secs(3)
    {
        thread::sleep(Duration::from_millis(25));
    }
    append_startup_log_handle(
        app,
        format!(
            "SQLite shutdown barrier completed. active_operations={}, duration_ms={}",
            state.active_critical_operations.load(Ordering::SeqCst),
            started.elapsed().as_millis()
        ),
    );
}

fn orderly_shutdown<R: tauri::Runtime>(app: &tauri::AppHandle<R>, cause: &str) {
    if app
        .try_state::<NextServerState>()
        .map(|state| state.shutting_down.swap(true, Ordering::SeqCst))
        .unwrap_or(false)
    {
        return;
    }
    wait_for_critical_operations(app);
    stop_next_server(app, cause);
}

#[tauri::command]
fn desktop_exit<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    append_startup_log_handle(&app, "Orderly desktop shutdown requested");
    orderly_shutdown(&app, "desktop_exit command");
    app.exit(0);
}

fn managed_app_data_root<R: tauri::Runtime>(manager: &impl Manager<R>) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            return Ok(PathBuf::from(local_app_data).join(WINDOWS_APP_DATA_DIR));
        }
        if let Some(app_data) = std::env::var_os("APPDATA") {
            return Ok(PathBuf::from(app_data).join(WINDOWS_APP_DATA_DIR));
        }
    }

    manager
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve Bezgrow's managed data folder: {error}"))
}

fn managed_data_directory<R: tauri::Runtime>(
    manager: &impl Manager<R>,
    name: &str,
) -> Result<PathBuf, String> {
    managed_app_data_root(manager).map(|root| root.join(name))
}

#[cfg(not(debug_assertions))]
fn runtime_state_path<R: tauri::Runtime>(manager: &impl Manager<R>) -> Result<PathBuf, String> {
    managed_data_directory(manager, RUNTIME_DIRECTORY).map(|path| path.join(RUNTIME_STATE_FILENAME))
}

#[cfg(not(debug_assertions))]
fn create_runtime_directory<R: tauri::Runtime>(
    manager: &impl Manager<R>,
) -> Result<PathBuf, String> {
    let directory = managed_data_directory(manager, RUNTIME_DIRECTORY)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create Bezgrow's runtime folder: {error}"))?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Unable to secure Bezgrow's runtime folder: {error}"))?;
    }
    Ok(directory)
}

#[cfg(not(debug_assertions))]
fn generate_runtime_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Unable to create the local runtime identity: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(not(debug_assertions))]
fn write_runtime_state<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ownership: &RuntimeOwnership,
) -> Result<(), String> {
    let directory = create_runtime_directory(app)?;
    let destination = directory.join(RUNTIME_STATE_FILENAME);
    let temporary = directory.join(format!(".runtime-{}.tmp", std::process::id()));
    let serialized = serde_json::to_vec_pretty(ownership)
        .map_err(|error| format!("Unable to encode Bezgrow's runtime ownership: {error}"))?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(target_os = "macos")]
    options.mode(0o600);
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Unable to create Bezgrow's runtime ownership file: {error}"))?;
    file.write_all(&serialized)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Unable to persist Bezgrow's runtime ownership: {error}"))?;
    #[cfg(target_os = "windows")]
    if destination.exists() {
        fs::remove_file(&destination)
            .map_err(|error| format!("Unable to replace stale runtime ownership: {error}"))?;
    }
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("Unable to activate Bezgrow's runtime ownership: {error}"))?;
    Ok(())
}

#[cfg(not(debug_assertions))]
fn read_runtime_state<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Option<RuntimeOwnership>, String> {
    let path = runtime_state_path(app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Unable to inspect Bezgrow's runtime ownership: {error}"))?;
    if metadata.len() > 64 * 1024 {
        return Err("Bezgrow's runtime ownership file is invalid.".to_string());
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Unable to read Bezgrow's runtime ownership: {error}"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("Bezgrow's runtime ownership file is invalid: {error}"))
}

#[cfg(not(debug_assertions))]
fn remove_runtime_state<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Ok(path) = runtime_state_path(app) {
        if let Err(error) = fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                append_startup_log_handle(
                    app,
                    format!("Unable to remove transient runtime ownership: {error}"),
                );
            }
        }
    }
}

#[cfg(not(debug_assertions))]
fn remove_runtime_state_if_owned<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ownership: &RuntimeOwnership,
) {
    match read_runtime_state(app) {
        Ok(Some(recorded))
            if recorded.server_pid == ownership.server_pid && recorded.token == ownership.token =>
        {
            remove_runtime_state(app);
        }
        Ok(_) => {}
        Err(error) => append_startup_log_handle(
            app,
            format!("Unable to verify transient runtime ownership during cleanup: {error}"),
        ),
    }
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn process_executable_path(pid: u32) -> Option<PathBuf> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "txt", "-Fn"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('n'))
        .filter(|path| path.starts_with('/'))
        .map(PathBuf::from)
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn process_current_directory(pid: u32) -> Option<PathBuf> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('n'))
        .filter(|path| path.starts_with('/'))
        .map(PathBuf::from)
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn process_parent_pid(pid: u32) -> Option<u32> {
    let output = Command::new("/bin/ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn all_process_ids() -> Vec<u32> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-c", "node", "-d", "cwd,txt", "-Fp"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix('p'))
        .filter_map(|line| line.parse().ok())
        .collect()
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn process_listening_ports(pid: u32) -> Vec<u16> {
    let output = Command::new("/usr/sbin/lsof")
        .args([
            "-nP",
            "-a",
            "-p",
            &pid.to_string(),
            "-iTCP",
            "-sTCP:LISTEN",
            "-Fn",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix('n'))
        .filter_map(|address| address.rsplit(':').next())
        .filter_map(|port| port.parse().ok())
        .collect()
}

#[cfg(all(target_os = "windows", not(debug_assertions)))]
fn process_executable_path(pid: u32) -> Option<PathBuf> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    let result = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe {
        CloseHandle(handle);
    }
    if result == 0 || length == 0 {
        return None;
    }
    buffer.truncate(length as usize);
    Some(PathBuf::from(OsString::from_wide(&buffer)))
}

#[cfg(all(target_os = "windows", not(debug_assertions)))]
use std::os::windows::ffi::OsStringExt;

#[cfg(all(
    not(debug_assertions),
    not(target_os = "macos"),
    not(target_os = "windows")
))]
fn process_executable_path(pid: u32) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(not(debug_assertions))]
fn same_process_path(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        return left
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .eq_ignore_ascii_case(right.to_string_lossy().trim_start_matches(r"\\?\"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

#[cfg(not(debug_assertions))]
fn process_matches_recorded_path(pid: u32, recorded: &str) -> bool {
    process_executable_path(pid)
        .map(|actual| same_process_path(&actual, Path::new(recorded)))
        .unwrap_or(false)
}

#[cfg(not(debug_assertions))]
fn looks_like_bundled_node(executable: &Path, server_entry: &Path) -> bool {
    let executable_name = executable.file_name().and_then(|name| name.to_str());
    let executable_parent = executable
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str());
    let entry_name = server_entry.file_name().and_then(|name| name.to_str());
    let entry_parent = server_entry
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str());
    let executable_ok = if cfg!(target_os = "windows") {
        executable_name
            .map(|name| name.eq_ignore_ascii_case("node.exe"))
            .unwrap_or(false)
    } else {
        executable_name == Some("node")
    };
    executable_ok
        && executable_parent == Some("node")
        && entry_name == Some("server.js")
        && entry_parent == Some("next-server")
}

#[cfg(not(debug_assertions))]
fn runtime_process_identity_matches(ownership: &RuntimeOwnership) -> bool {
    let executable = Path::new(&ownership.server_executable);
    let entry = Path::new(&ownership.server_entry);
    ownership.schema_version == RUNTIME_STATE_SCHEMA
        && ownership.token.len() == 64
        && ownership.token.bytes().all(|byte| byte.is_ascii_hexdigit())
        && looks_like_bundled_node(executable, entry)
        && process_matches_recorded_path(ownership.server_pid, &ownership.server_executable)
}

#[cfg(not(debug_assertions))]
fn looks_like_bezgrow_shell(executable: &Path) -> bool {
    executable
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            name.eq_ignore_ascii_case(if cfg!(target_os = "windows") {
                "Bezgrow.exe"
            } else {
                "Bezgrow"
            })
        })
        .unwrap_or(false)
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn listening_process_ids(port: u16) -> Vec<u32> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-t", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
}

#[cfg(all(target_os = "windows", not(debug_assertions)))]
fn listening_process_ids(port: u16) -> Vec<u32> {
    let mut size = 0_u32;
    unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
    }
    if size < std::mem::size_of::<u32>() as u32 {
        return Vec::new();
    }
    let mut buffer = vec![0_u8; size as usize];
    let result = unsafe {
        GetExtendedTcpTable(
            buffer.as_mut_ptr().cast(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if result != 0 {
        return Vec::new();
    }
    let count = unsafe { *(buffer.as_ptr().cast::<u32>()) as usize };
    let rows = unsafe {
        std::slice::from_raw_parts(
            buffer
                .as_ptr()
                .add(std::mem::size_of::<u32>())
                .cast::<MIB_TCPROW_OWNER_PID>(),
            count,
        )
    };
    rows.iter()
        .filter(|row| u16::from_be(row.dwLocalPort as u16) == port)
        .map(|row| row.dwOwningPid)
        .collect()
}

#[cfg(all(
    not(debug_assertions),
    not(target_os = "macos"),
    not(target_os = "windows")
))]
fn listening_process_ids(_port: u16) -> Vec<u32> {
    Vec::new()
}

#[cfg(not(debug_assertions))]
fn port_is_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

#[cfg(not(debug_assertions))]
fn wait_for_port_release(port: u16, timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if port_is_available(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(40));
    }
    port_is_available(port)
}

fn startup_log_path<R: tauri::Runtime>(manager: &impl Manager<R>) -> PathBuf {
    managed_data_directory(manager, "Logs")
        .unwrap_or_else(|_| std::env::temp_dir().join(WINDOWS_APP_DATA_DIR))
        .join("bezgrow-startup.log")
}

fn rotate_startup_log<R: tauri::Runtime>(manager: &impl Manager<R>) {
    let path = startup_log_path(manager);
    let Ok(metadata) = fs::metadata(&path) else {
        return;
    };
    if metadata.len() < STARTUP_LOG_MAX_BYTES {
        return;
    }

    for generation in (1..STARTUP_LOG_GENERATIONS).rev() {
        let source = path.with_extension(format!("log.{generation}"));
        let destination = path.with_extension(format!("log.{}", generation + 1));
        if source.exists() {
            let _ = fs::rename(source, destination);
        }
    }
    let _ = fs::rename(&path, path.with_extension("log.1"));
}

#[cfg(target_os = "windows")]
fn early_startup_log_path() -> PathBuf {
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local_app_data)
            .join(WINDOWS_APP_DATA_DIR)
            .join("Logs")
            .join("bezgrow-startup.log");
    }
    if let Some(app_data) = std::env::var_os("APPDATA") {
        return PathBuf::from(app_data)
            .join(WINDOWS_APP_DATA_DIR)
            .join("Logs")
            .join("bezgrow-startup.log");
    }

    std::env::temp_dir()
        .join(WINDOWS_APP_DATA_DIR)
        .join("bezgrow-startup.log")
}

#[cfg(target_os = "windows")]
fn append_early_startup_log(message: impl AsRef<str>) {
    let path = early_startup_log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "[{}] {}", unix_timestamp(), message.as_ref());
}

fn append_startup_log<R: tauri::Runtime>(manager: &impl Manager<R>, message: impl AsRef<str>) {
    let path = startup_log_path(manager);

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "unknown-time".to_string());

    let _ = writeln!(file, "[{timestamp}] {}", message.as_ref());
}

#[tauri::command]
fn desktop_startup_log<R: tauri::Runtime>(app: tauri::AppHandle<R>, message: String) {
    let sanitized = message.replace(['\r', '\n'], " ");
    append_startup_log_handle(&app, sanitized);
}

fn append_startup_log_handle<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    message: impl AsRef<str>,
) {
    let path = managed_data_directory(app, "Logs")
        .unwrap_or_else(|_| std::env::temp_dir().join(WINDOWS_APP_DATA_DIR))
        .join("bezgrow-startup.log");

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };

    let timestamp = unix_timestamp();
    let _ = writeln!(file, "[{timestamp}] {}", message.as_ref());
}

fn create_startup_error_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    startup_error: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let log_path = startup_log_path(app);
    let diagnostics = serde_json::json!({
        "message": startup_error,
        "logPath": log_path.to_string_lossy(),
    })
    .to_string();

    if let Some(window) = app.get_webview_window("startup-error") {
        window.eval(format!(
            "window.__BEZGROW_SET_STARTUP_ERROR__?.({diagnostics});"
        ))?;
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        app,
        "startup-error",
        WebviewUrl::App("startup-error.html".into()),
    )
    .title("Bezgrow ERP")
    .inner_size(760.0, 520.0)
    .min_inner_size(640.0, 420.0)
    .resizable(true)
    .initialization_script(format!("window.__BEZGROW_STARTUP_ERROR__ = {diagnostics};"))
    .build()?;

    Ok(())
}

fn keychain_entry(key: &str) -> Result<keyring::Entry, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key).map_err(|error| error.to_string())?;
    if entry.get_credential().is::<keyring::mock::MockCredential>() {
        return Err("The native secure credential store is unavailable in this build.".to_string());
    }
    Ok(entry)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopDatabaseDiagnostics {
    application_version: String,
    app_config_dir: String,
    app_data_dir: String,
    database_path: String,
    device_id_source: String,
    license_state_source: String,
    legacy_migration_occurred: bool,
    legacy_migration_source: Option<String>,
    parent_exists: bool,
    parent_created: bool,
    parent_writable: bool,
    database_exists: bool,
    database_bytes: u64,
}

#[derive(Default)]
struct ManagedDataPreparation {
    legacy_migration_occurred: bool,
    legacy_migration_source: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopDatabaseBackup {
    backup_path: String,
    checksum_sha256: String,
    bytes: u64,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdatePreflight {
    integrity: String,
    foreign_key_violations: usize,
    backup: Option<DesktopDatabaseBackup>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedReleaseDownloadRequest {
    url: String,
    version: String,
    platform: String,
    architecture: String,
    filename: String,
    size: u64,
    sha256: String,
    trust_state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedReleaseDownload {
    path: String,
    filename: String,
    bytes: u64,
    sha256: String,
    version: String,
    trust_state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSqlStatement {
    query: String,
    #[serde(default)]
    bind_values: Vec<serde_json::Value>,
    #[serde(default)]
    ignore_duplicate_column: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTransactionResult {
    statements: usize,
    rows_affected: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSavedFile {
    path: String,
    filename: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopOpenedPdf {
    path: String,
    filename: String,
    bytes: u64,
    page_count: usize,
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPlatformAdminProof {
    device_id: String,
    public_key: String,
    signature: String,
    timestamp: String,
    nonce: String,
}

struct NativePrintLaunch {
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBusinessLogo {
    relative_path: String,
    absolute_path: String,
    mime_type: String,
    width: u32,
    height: u32,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLocalAsset {
    mime_type: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupAssetManifest {
    relative_path: String,
    checksum_sha256: String,
    bytes: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBackupManifest {
    app: String,
    format_version: u32,
    app_version: String,
    schema_version: i64,
    organization_id: String,
    created_at: String,
    database_checksum_sha256: String,
    database_bytes: u64,
    assets: Vec<BackupAssetManifest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRestoreResult {
    backup_path: String,
    pre_restore_backup_path: String,
    schema_version: i64,
    organization_id: String,
}

const MAX_BACKUP_PACKAGE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_BACKUP_DATABASE_BYTES: u64 = 3 * 1024 * 1024 * 1024;
const MAX_BACKUP_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_BACKUP_ASSET_BYTES: u64 = 256 * 1024 * 1024;
const MAX_BACKUP_ASSET_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_BACKUP_ASSET_COUNT: usize = 10_000;

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn unix_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "unknown-time".to_string())
}

fn local_database_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        return managed_data_directory(app, "Database").map(|path| path.join(LOCAL_DATABASE_NAME));
    }

    #[cfg(not(target_os = "windows"))]
    {
        app.path()
            .app_config_dir()
            .map(|path| path.join(LOCAL_DATABASE_NAME))
            .map_err(|error| format!("Unable to resolve desktop app data directory: {error}"))
    }
}

#[cfg(any(target_os = "windows", test))]
async fn verify_legacy_bezgrow_database(database_path: &Path) -> Result<(), String> {
    if !database_path.is_file() {
        return Err("The previous Bezgrow database file is missing.".to_string());
    }
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .read_only(true)
        .busy_timeout(Duration::from_secs(10));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open the previous Bezgrow database: {error}"))?;
    let quick = sqlx::query_scalar::<_, String>("PRAGMA quick_check")
        .fetch_one(&mut connection)
        .await
        .map_err(|error| format!("Unable to verify the previous Bezgrow database: {error}"))?;
    if !quick.eq_ignore_ascii_case("ok") {
        return Err(format!(
            "The previous Bezgrow database failed its integrity check: {quick}"
        ));
    }
    let tables: HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT name FROM sqlite_master WHERE type = 'table'")
            .fetch_all(&mut connection)
            .await
            .map_err(|error| format!("Unable to inspect the previous Bezgrow schema: {error}"))?
            .into_iter()
            .collect();
    let has_business_identity = tables.contains("organizations")
        || tables.contains("local_organizations")
        || tables.contains("local_workspace");
    let has_bezgrow_state = [
        "schema_migrations",
        "license_state",
        "products",
        "local_products",
        "sales_invoices",
        "local_invoices",
    ]
    .iter()
    .filter(|table| tables.contains(**table))
    .count()
        >= 2;
    if !has_business_identity || !has_bezgrow_state {
        return Err(
            "The previous database does not contain a recognized Bezgrow schema; it was not migrated."
                .to_string(),
        );
    }
    connection
        .close()
        .await
        .map_err(|error| format!("Unable to finish inspecting the previous database: {error}"))?;
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn sqlite_sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", database_path.to_string_lossy()))
}

#[cfg(any(target_os = "windows", test))]
async fn migrate_legacy_database_missing(
    legacy_database: &Path,
    destination_database: &Path,
) -> Result<bool, String> {
    if destination_database.exists() || !legacy_database.is_file() {
        return Ok(false);
    }
    verify_legacy_bezgrow_database(legacy_database).await?;
    let parent = destination_database
        .parent()
        .ok_or_else(|| "The canonical Bezgrow database folder is invalid.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create the canonical database folder: {error}"))?;
    let temporary = destination_database.with_extension(format!(
        "migration-{}-{}.tmp",
        std::process::id(),
        unix_timestamp()
    ));
    fs::copy(legacy_database, &temporary)
        .map_err(|error| format!("Unable to stage the previous Bezgrow database: {error}"))?;

    let legacy_wal = sqlite_sidecar_path(legacy_database, "-wal");
    let temporary_wal = sqlite_sidecar_path(&temporary, "-wal");
    if legacy_wal.is_file() {
        if let Err(error) = fs::copy(&legacy_wal, &temporary_wal) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("Unable to stage the previous SQLite WAL: {error}"));
        }
    }
    if temporary_wal.is_file() {
        let options = SqliteConnectOptions::new()
            .filename(&temporary)
            .create_if_missing(false)
            .read_only(false)
            .busy_timeout(Duration::from_secs(10));
        let mut staged = SqliteConnection::connect_with(&options)
            .await
            .map_err(|error| format!("Unable to open the staged Bezgrow database: {error}"))?;
        sqlx::query("PRAGMA wal_checkpoint(FULL)")
            .execute(&mut staged)
            .await
            .map_err(|error| format!("Unable to consolidate the staged SQLite WAL: {error}"))?;
        sqlx::query("PRAGMA journal_mode = DELETE")
            .execute(&mut staged)
            .await
            .map_err(|error| format!("Unable to finalize the staged SQLite snapshot: {error}"))?;
        staged
            .close()
            .await
            .map_err(|error| format!("Unable to close the staged Bezgrow database: {error}"))?;
        let _ = fs::remove_file(&temporary_wal);
        let _ = fs::remove_file(sqlite_sidecar_path(&temporary, "-shm"));
    }
    if let Err(error) = verify_legacy_bezgrow_database(&temporary).await {
        let _ = fs::remove_file(&temporary);
        let _ = fs::remove_file(&temporary_wal);
        let _ = fs::remove_file(sqlite_sidecar_path(&temporary, "-shm"));
        return Err(error);
    }

    fs::rename(&temporary, destination_database)
        .map_err(|error| format!("Unable to activate the migrated Bezgrow database: {error}"))?;
    let _ = fs::remove_file(sqlite_sidecar_path(&temporary, "-shm"));
    Ok(true)
}

fn prepare_managed_data<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<ManagedDataPreparation, String> {
    #[allow(unused_mut)]
    let mut preparation = ManagedDataPreparation::default();
    let root = managed_app_data_root(app)?;
    for directory in [
        "Database",
        INSTALLATION_DIRECTORY,
        "business-assets/logos",
        "Settings",
        "PDFs",
        "Exports",
        "Temporary",
        "Backups",
        "Logs",
        "Runtime",
        "WebView",
    ] {
        fs::create_dir_all(root.join(directory))
            .map_err(|error| format!("Unable to create Bezgrow's {directory} folder: {error}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(roaming_app_data) = std::env::var_os("APPDATA") {
            let previous_root = PathBuf::from(roaming_app_data).join(WINDOWS_APP_DATA_DIR);
            if previous_root != root && previous_root.is_dir() {
                let previous_database = [
                    previous_root.join("Database").join(LOCAL_DATABASE_NAME),
                    previous_root.join(LOCAL_DATABASE_NAME),
                ]
                .into_iter()
                .find(|path| path.is_file());
                let previous_device = previous_root
                    .join(INSTALLATION_DIRECTORY)
                    .join(DEVICE_ID_FILENAME);
                let database_recognized = previous_database
                    .as_ref()
                    .map(|path| {
                        tauri::async_runtime::block_on(verify_legacy_bezgrow_database(path)).is_ok()
                    })
                    .unwrap_or(false);
                let device_recognized = read_persisted_device_id(&previous_device)?.is_some();
                if database_recognized || device_recognized {
                    if let Some(previous_database) =
                        previous_database.filter(|_| database_recognized)
                    {
                        let destination_database = root.join("Database").join(LOCAL_DATABASE_NAME);
                        if tauri::async_runtime::block_on(migrate_legacy_database_missing(
                            &previous_database,
                            &destination_database,
                        ))? {
                            preparation.legacy_migration_occurred = true;
                            preparation.legacy_migration_source =
                                Some(previous_root.to_string_lossy().to_string());
                        }
                    }
                    let copied = copy_directory_missing_without_sqlite(&previous_root, &root)?;
                    if copied > 0 {
                        preparation.legacy_migration_occurred = true;
                        preparation.legacy_migration_source =
                            Some(previous_root.to_string_lossy().to_string());
                    }
                }
            }
        }
        let legacy_config = app.path().app_config_dir().map_err(|error| {
            format!("Unable to inspect the previous Bezgrow database folder: {error}")
        })?;
        let legacy_data = app.path().app_data_dir().map_err(|error| {
            format!("Unable to inspect the previous Bezgrow data folder: {error}")
        })?;
        let destination_database = root.join("Database").join(LOCAL_DATABASE_NAME);
        let legacy_database = legacy_config.join(LOCAL_DATABASE_NAME);

        if tauri::async_runtime::block_on(migrate_legacy_database_missing(
            &legacy_database,
            &destination_database,
        ))? {
            preparation.legacy_migration_occurred = true;
            preparation.legacy_migration_source = Some(legacy_config.to_string_lossy().to_string());
        }

        for directory in ["business-assets", "backups"] {
            let source = legacy_data.join(directory);
            let destination = root.join(directory);
            if source.is_dir() {
                let copied = copy_directory_missing(&source, &destination)?;
                if copied > 0 {
                    preparation.legacy_migration_occurred = true;
                    preparation
                        .legacy_migration_source
                        .get_or_insert_with(|| legacy_data.to_string_lossy().to_string());
                }
            }
        }
    }

    Ok(preparation)
}

fn sha256_file(path: &PathBuf) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Unable to open backup for checksum: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let bytes = file
            .read(&mut buffer)
            .map_err(|error| format!("Unable to read backup for checksum: {error}"))?;
        if bytes == 0 {
            break;
        }
        hasher.update(&buffer[..bytes]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn valid_device_id(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("BZG-")
        && (12..=96).contains(&trimmed.len())
        && trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn read_persisted_device_id(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let value = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read Bezgrow's installation identity: {error}"))?;
    let trimmed = value.trim();
    if !valid_device_id(trimmed) {
        return Err("Bezgrow's persisted installation identity is invalid. Restore the application-data folder from backup or contact support; a replacement Device ID was not generated.".to_string());
    }
    Ok(Some(trimmed.to_string()))
}

fn write_new_identity_file(path: &Path, value: &str) -> Result<(), String> {
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Unable to persist Bezgrow's installation identity: {error}"
            ))
        }
    };
    file.write_all(value.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| {
            format!("Unable to finish persisting Bezgrow's installation identity: {error}")
        })
}

fn get_or_create_device_id_at(
    installation_directory: &Path,
    legacy_device_id: Option<&str>,
) -> Result<String, String> {
    fs::create_dir_all(installation_directory)
        .map_err(|error| format!("Unable to create Bezgrow's installation-data folder: {error}"))?;
    let device_path = installation_directory.join(DEVICE_ID_FILENAME);
    if let Some(existing) = read_persisted_device_id(&device_path)? {
        return Ok(existing);
    }

    if let Some(legacy) = legacy_device_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !valid_device_id(legacy) {
            return Err(
                "The previous Device ID is invalid, so Bezgrow did not replace it automatically."
                    .to_string(),
            );
        }
        write_new_identity_file(&device_path, legacy)?;
        return read_persisted_device_id(&device_path)?.ok_or_else(|| {
            "Bezgrow could not verify the migrated installation Device ID.".to_string()
        });
    }

    let seed_path = installation_directory.join(INSTALLATION_SEED_FILENAME);
    let seed = if seed_path.exists() {
        fs::read_to_string(&seed_path)
            .map_err(|error| format!("Unable to read Bezgrow's installation seed: {error}"))?
    } else {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos().to_string())
            .unwrap_or_else(|_| unix_timestamp());
        let material = format!(
            "bezgrow-installation-v1|{}|{}|{}",
            installation_directory.display(),
            std::process::id(),
            timestamp
        );
        let generated = sha256_bytes(material.as_bytes());
        write_new_identity_file(&seed_path, &generated)?;
        fs::read_to_string(&seed_path)
            .map_err(|error| format!("Unable to verify Bezgrow's installation seed: {error}"))?
    };
    let digest = sha256_bytes(format!("bezgrow-device-v1|{}", seed.trim()).as_bytes());
    let generated = format!("BZG-{}", digest[..24].to_ascii_uppercase());
    write_new_identity_file(&device_path, &generated)?;
    read_persisted_device_id(&device_path)?
        .ok_or_else(|| "Bezgrow could not verify the new installation Device ID.".to_string())
}

#[tauri::command]
fn desktop_get_or_create_device_id<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    legacy_device_id: Option<String>,
) -> Result<String, String> {
    let directory = managed_data_directory(&app, INSTALLATION_DIRECTORY)?;
    get_or_create_device_id_at(&directory, legacy_device_id.as_deref())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_platform_admin_signing_key(value: &str) -> Result<[u8; 32], String> {
    let value = value.trim();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The protected Platform Admin device key is invalid.".to_string());
    }
    let mut bytes = [0_u8; 32];
    for (index, slot) in bytes.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "The protected Platform Admin device key is invalid.".to_string())?;
    }
    Ok(bytes)
}

fn read_platform_admin_signing_key_file(path: &Path) -> Result<Option<[u8; 32]>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::metadata(path).map_err(|error| {
        format!("Unable to inspect the protected Platform Admin device key: {error}")
    })?;
    if !metadata.is_file() {
        return Err("The protected Platform Admin device key path is invalid.".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(
                "The protected Platform Admin device key permissions are unsafe.".to_string(),
            );
        }
    }
    let value = fs::read_to_string(path).map_err(|error| {
        format!("Unable to read the protected Platform Admin device key: {error}")
    })?;
    decode_platform_admin_signing_key(&value).map(Some)
}

fn write_platform_admin_signing_key_file(path: &Path, bytes: &[u8; 32]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Unable to persist the protected Platform Admin device key: {error}"
            ))
        }
    };
    file.write_all(hex_encode(bytes).as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| {
            format!("Unable to finish protecting the Platform Admin device key: {error}")
        })
}

fn platform_admin_signing_key(
    installation_directory: &Path,
    device_id: &str,
) -> Result<SigningKey, String> {
    let file_path = installation_directory.join(PLATFORM_ADMIN_SIGNING_KEY_FILENAME);
    if let Some(bytes) = read_platform_admin_signing_key_file(&file_path)? {
        return Ok(SigningKey::from_bytes(&bytes));
    }

    let credential_name = format!("{PLATFORM_ADMIN_SIGNING_KEY_PREFIX}:{device_id}");
    let entry = keychain_entry(&credential_name)?;
    let private_bytes = match entry.get_password() {
        Ok(value) => decode_platform_admin_signing_key(&value)?,
        Err(keyring::Error::NoEntry) => {
            let mut private_bytes = [0_u8; 32];
            getrandom::fill(&mut private_bytes).map_err(|error| {
                format!("Unable to create the protected Platform Admin device key: {error}")
            })?;
            // Keychain remains the preferred native copy. Internal/ad-hoc macOS
            // builds can lose access to an item when their code requirement
            // changes, so the permission-restricted installation copy below is
            // the stable device-bound fallback.
            let _ = entry.set_password(&hex_encode(&private_bytes));
            private_bytes
        }
        Err(error) => {
            return Err(format!(
                "Unable to read the protected Platform Admin device key: {error}"
            ))
        }
    };
    write_platform_admin_signing_key_file(&file_path, &private_bytes)?;
    let persisted = read_platform_admin_signing_key_file(&file_path)?
        .ok_or_else(|| "The protected Platform Admin device key was not persisted.".to_string())?;
    Ok(SigningKey::from_bytes(&persisted))
}

fn valid_platform_admin_proof_path(path_and_query: &str) -> bool {
    !path_and_query.contains('\r')
        && !path_and_query.contains('\n')
        && path_and_query.len() <= 2_048
        && (path_and_query == "/api/admin/session"
            || path_and_query.starts_with("/api/admin/")
            || path_and_query == "/api/platform-admin/device/authorize"
            || path_and_query == "/api/platform-admin/device/status")
}

#[tauri::command]
fn desktop_platform_admin_proof<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    method: String,
    path_and_query: String,
    body_sha256: String,
) -> Result<DesktopPlatformAdminProof, String> {
    let method = method.trim().to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "HEAD" | "POST" | "PATCH") {
        return Err("This Platform Admin request method is not allowed.".to_string());
    }
    if !valid_platform_admin_proof_path(&path_and_query) {
        return Err("This Platform Admin request path is not allowed.".to_string());
    }
    let body_sha256 = body_sha256.trim().to_ascii_lowercase();
    if body_sha256.len() != 64 || !body_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The Platform Admin request digest is invalid.".to_string());
    }

    let installation_directory = managed_data_directory(&app, INSTALLATION_DIRECTORY)?;
    let device_id = get_or_create_device_id_at(&installation_directory, None)?;
    let signing_key = platform_admin_signing_key(&installation_directory, &device_id)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "The system clock is invalid for Platform Administration.".to_string())?
        .as_secs()
        .to_string();
    let mut nonce_bytes = [0_u8; 24];
    getrandom::fill(&mut nonce_bytes)
        .map_err(|error| format!("Unable to create a Platform Admin request nonce: {error}"))?;
    let nonce = hex_encode(&nonce_bytes);
    let canonical = format!(
        "bezgrow-platform-admin-v1\n{method}\n{path_and_query}\n{body_sha256}\n{device_id}\n{timestamp}\n{nonce}"
    );
    let signature = signing_key.sign(canonical.as_bytes());
    append_startup_log_handle(
        &app,
        format!("Platform Admin request signed for device={device_id} path={path_and_query}"),
    );

    Ok(DesktopPlatformAdminProof {
        device_id,
        public_key: hex_encode(signing_key.verifying_key().as_bytes()),
        signature: hex_encode(&signature.to_bytes()),
        timestamp,
        nonce,
    })
}

fn sanitize_filename(filename: &str, fallback: &str) -> String {
    let sanitized: String = filename
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ' ') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches(['.', '-', ' ']);
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn safe_extension(filename: &str, extension: &str) -> String {
    let suffix = format!(
        ".{}",
        extension.trim_start_matches('.').to_ascii_lowercase()
    );
    if filename.to_ascii_lowercase().ends_with(&suffix) {
        filename.to_string()
    } else {
        format!("{filename}{suffix}")
    }
}

fn save_bytes_with_dialog<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    filename: &str,
    bytes: &[u8],
    kind: &str,
) -> Result<Option<DesktopSavedFile>, String> {
    let (description, extension, fallback) = match kind {
        "pdf" => ("PDF document", "pdf", "Invoice.pdf"),
        "csv" => ("CSV spreadsheet", "csv", "bezgrow-export.csv"),
        "json" => ("JSON diagnostics", "json", "bezgrow-diagnostics.json"),
        "backup" => (
            "Bezgrow backup",
            "bezgrow-backup",
            "bezgrow-backup.bezgrow-backup",
        ),
        _ => return Err("Unsupported desktop file type.".to_string()),
    };
    let safe_name = safe_extension(&sanitize_filename(filename, fallback), extension);
    let default_directory = match kind {
        "pdf" => managed_data_directory(app, "PDFs"),
        "csv" => managed_data_directory(app, "Exports"),
        "json" => managed_data_directory(app, "Logs"),
        "backup" => managed_data_directory(app, "Backups"),
        _ => managed_app_data_root(app),
    }?;
    fs::create_dir_all(&default_directory)
        .map_err(|error| format!("Unable to create the default save folder: {error}"))?;
    let destination = rfd::FileDialog::new()
        .set_directory(default_directory)
        .set_file_name(&safe_name)
        .add_filter(description, &[extension])
        .save_file();
    let Some(path) = destination else {
        return Ok(None);
    };

    let parent = path
        .parent()
        .ok_or_else(|| "The selected destination folder is invalid.".to_string())?;
    if !parent.exists() {
        return Err("The selected destination folder no longer exists.".to_string());
    }

    let temporary = parent.join(format!(".{}.{}.tmp", safe_name, unix_timestamp()));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Unable to write the selected file: {error}"))?;
    if let Err(initial_error) = fs::rename(&temporary, &path) {
        let replacement_result = if path.exists() {
            fs::remove_file(&path).and_then(|()| fs::rename(&temporary, &path))
        } else {
            Err(initial_error)
        };
        if let Err(error) = replacement_result {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "Unable to finish saving the selected file: {error}"
            ));
        }
    }

    let written = fs::read(&path)
        .map_err(|error| format!("Unable to reopen the saved file for verification: {error}"))?;
    if written != bytes {
        return Err("The saved file bytes do not match the generated document.".to_string());
    }
    if kind == "pdf" {
        let expected_page_count = pdf_page_count(bytes);
        validate_pdf_for_native_open(&written, expected_page_count)?;
    }

    let metadata =
        fs::metadata(&path).map_err(|error| format!("Unable to verify the saved file: {error}"))?;
    Ok(Some(DesktopSavedFile {
        path: path.to_string_lossy().to_string(),
        filename: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&safe_name)
            .to_string(),
        bytes: metadata.len(),
    }))
}

fn image_signature(bytes: &[u8]) -> Option<(ImageFormat, &'static str, &'static str)> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some((ImageFormat::Png, "image/png", "png"));
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some((ImageFormat::Jpeg, "image/jpeg", "jpg"));
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some((ImageFormat::WebP, "image/webp", "webp"));
    }
    None
}

fn organization_asset_stem(organization_id: &str) -> Result<String, String> {
    let trimmed = organization_id.trim();
    if trimmed.is_empty() {
        return Err("A business must be selected before choosing a logo.".to_string());
    }
    Ok(sha256_bytes(trimmed.as_bytes())[..24].to_string())
}

fn local_asset_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("The local asset path is invalid.".to_string());
    }
    if !relative_path.starts_with("business-assets/") {
        return Err("The local asset is outside Bezgrow's managed asset folder.".to_string());
    }
    managed_app_data_root(app).map(|root| root.join(path))
}

#[tauri::command]
fn close_platform_admin<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("platform-admin")
        .ok_or_else(|| "The Platform Administration window is not open.".to_string())?;
    window
        .close()
        .map_err(|_| "Platform Administration could not return to the local ERP.".to_string())
}

#[tauri::command]
fn desktop_copy_text(value: String) -> Result<(), String> {
    if value.is_empty() {
        return Err("There is no text to copy.".to_string());
    }
    if value.len() > 100_000 {
        return Err("The text is too large to copy safely.".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut child = Command::new("/usr/bin/pbcopy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "The macOS clipboard is unavailable.".to_string())?;

    #[cfg(target_os = "windows")]
    let mut child = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$value = [Console]::In.ReadToEnd(); Set-Clipboard -Value $value",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "The Windows clipboard is unavailable.".to_string())?;

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("Native clipboard copy is unavailable on this platform.".to_string());

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        child
            .stdin
            .take()
            .ok_or_else(|| "The native clipboard input is unavailable.".to_string())?
            .write_all(value.as_bytes())
            .map_err(|_| "The signed licence key could not be copied.".to_string())?;
        let status = child
            .wait()
            .map_err(|_| "The native clipboard did not finish.".to_string())?;
        if !status.success() {
            return Err("The native clipboard rejected the text.".to_string());
        }
        Ok(())
    }
}

#[tauri::command]
fn desktop_save_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    filename: String,
    bytes: Vec<u8>,
    file_kind: String,
) -> Result<Option<DesktopSavedFile>, String> {
    let _operation = begin_critical_operation(&app)?;
    if bytes.is_empty() {
        return Err("The file is empty and was not saved.".to_string());
    }
    if file_kind == "pdf" && (bytes.len() < 5 || !bytes.starts_with(b"%PDF-")) {
        return Err("The generated invoice is not a valid PDF.".to_string());
    }
    if file_kind == "csv" && !bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err("The CSV export must be UTF-8 with an Excel-compatible BOM.".to_string());
    }
    if file_kind == "json" {
        serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|_| "The diagnostic export must be valid JSON.".to_string())?;
    }
    save_bytes_with_dialog(&app, &filename, &bytes, &file_kind)
}

fn prepare_invoice_share_at(
    directory: &Path,
    filename: &str,
    bytes: &[u8],
) -> Result<DesktopSavedFile, String> {
    let expected_page_count = pdf_page_count(bytes);
    validate_pdf_for_native_open(bytes, expected_page_count)
        .map_err(|error| format!("The invoice PDF was not prepared for sharing: {error}"))?;

    let safe_name = safe_extension(&sanitize_filename(filename, "Invoice.pdf"), "pdf");
    fs::create_dir_all(directory)
        .map_err(|error| format!("Unable to create the local invoice-share folder: {error}"))?;
    let destination = directory.join(&safe_name);
    let temporary = directory.join(format!(".{safe_name}.tmp"));
    let write_result = (|| {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("Unable to prepare the local invoice PDF: {error}"))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| {
                format!("Unable to finish preparing the local invoice PDF: {error}")
            })?;
        if let Err(initial_error) = fs::rename(&temporary, &destination) {
            let replacement = if destination.is_file() {
                fs::remove_file(&destination).and_then(|()| fs::rename(&temporary, &destination))
            } else {
                Err(initial_error)
            };
            replacement
                .map_err(|error| format!("Unable to replace the prepared invoice PDF: {error}"))?;
        }
        Ok::<(), String>(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result?;
    let written = fs::read(&destination)
        .map_err(|error| format!("Unable to reopen the prepared invoice PDF: {error}"))?;
    validate_pdf_for_native_open(&written, expected_page_count)
        .map_err(|error| format!("Unable to verify the prepared invoice PDF: {error}"))?;
    if written != bytes {
        return Err(
            "The prepared invoice PDF bytes do not match the validated document.".to_string(),
        );
    }
    Ok(DesktopSavedFile {
        path: destination.to_string_lossy().to_string(),
        filename: safe_name,
        bytes: written.len() as u64,
    })
}

#[tauri::command]
fn desktop_prepare_invoice_share<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    filename: String,
    bytes: Vec<u8>,
) -> Result<DesktopSavedFile, String> {
    let _operation = begin_critical_operation(&app)?;
    let directory = managed_data_directory(&app, "Exports")?.join("Invoice Shares");
    prepare_invoice_share_at(&directory, &filename, &bytes)
}

#[tauri::command]
fn desktop_pick_business_logo<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    organization_id: String,
) -> Result<Option<DesktopBusinessLogo>, String> {
    let _operation = begin_critical_operation(&app)?;
    const MAX_INPUT_BYTES: u64 = 5 * 1024 * 1024;
    const MAX_DIMENSION: u32 = 1200;

    let source = rfd::FileDialog::new()
        .add_filter("Business logo", &["png", "jpg", "jpeg", "webp"])
        .pick_file();
    let Some(source_path) = source else {
        return Ok(None);
    };
    let metadata = fs::metadata(&source_path)
        .map_err(|error| format!("Unable to inspect the selected logo: {error}"))?;
    if metadata.len() == 0 {
        return Err("The selected logo file is empty.".to_string());
    }
    if metadata.len() > MAX_INPUT_BYTES {
        return Err("The business logo must be 5 MB or smaller.".to_string());
    }

    let source_bytes = fs::read(&source_path)
        .map_err(|error| format!("Unable to read the selected logo: {error}"))?;
    let Some((format, mime_type, extension)) = image_signature(&source_bytes) else {
        return Err("Choose a valid PNG, JPEG, or WebP image.".to_string());
    };
    let decoded = image::load_from_memory_with_format(&source_bytes, format)
        .map_err(|_| "The selected logo is damaged or is not a supported image.".to_string())?;
    let (source_width, source_height) = decoded.dimensions();
    if source_width < 16 || source_height < 16 {
        return Err("The business logo must be at least 16 x 16 pixels.".to_string());
    }
    if source_width > 16_384 || source_height > 16_384 {
        return Err("The business logo dimensions are too large.".to_string());
    }

    let processed = if source_width > MAX_DIMENSION || source_height > MAX_DIMENSION {
        decoded.resize(
            MAX_DIMENSION,
            MAX_DIMENSION,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        decoded
    };
    let (width, height) = processed.dimensions();
    let mut output = Cursor::new(Vec::new());
    processed
        .write_to(&mut output, format)
        .map_err(|error| format!("Unable to process the selected logo: {error}"))?;
    let output = output.into_inner();

    let stem = organization_asset_stem(&organization_id)?;
    let relative_path = format!("business-assets/logos/{stem}.{extension}");
    let destination = local_asset_path(&app, &relative_path)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "Unable to resolve the business logo folder.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create the business logo folder: {error}"))?;
    let temporary = parent.join(format!(".{stem}.{}.tmp", unix_timestamp()));
    fs::write(&temporary, &output)
        .map_err(|error| format!("Unable to save the processed business logo: {error}"))?;
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("Unable to finish saving the business logo: {error}"))?;

    for candidate_extension in ["png", "jpg", "webp"] {
        if candidate_extension == extension {
            continue;
        }
        let _ = fs::remove_file(parent.join(format!("{stem}.{candidate_extension}")));
    }

    Ok(Some(DesktopBusinessLogo {
        relative_path,
        absolute_path: destination.to_string_lossy().to_string(),
        mime_type: mime_type.to_string(),
        width,
        height,
        bytes: output.len() as u64,
    }))
}

#[tauri::command]
fn desktop_remove_business_logo<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    relative_path: String,
) -> Result<(), String> {
    let _operation = begin_critical_operation(&app)?;
    let path = local_asset_path(&app, &relative_path)?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Unable to remove the business logo: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn desktop_read_local_asset<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    relative_path: String,
) -> Result<DesktopLocalAsset, String> {
    let path = local_asset_path(&app, &relative_path)?;
    if !path.is_file() {
        return Err("The local business asset could not be found.".to_string());
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Unable to read the local business asset: {error}"))?;
    let Some((_, mime_type, _)) = image_signature(&bytes) else {
        return Err("The local business asset is not a valid supported image.".to_string());
    };
    Ok(DesktopLocalAsset {
        mime_type: mime_type.to_string(),
        bytes,
    })
}

fn pdf_page_count(bytes: &[u8]) -> usize {
    const PAGE_MARKER: &[u8] = b"/Type /Page";
    bytes
        .windows(PAGE_MARKER.len() + 1)
        .filter(|window| {
            window.starts_with(PAGE_MARKER)
                && !window
                    .get(PAGE_MARKER.len())
                    .is_some_and(|next| *next == b's')
        })
        .count()
}

fn validate_pdf_for_native_open(bytes: &[u8], expected_page_count: usize) -> Result<usize, String> {
    if bytes.len() < 1_500 || !bytes.starts_with(b"%PDF-") {
        return Err("The invoice PDF is empty or does not have a valid PDF header.".to_string());
    }
    let tail_start = bytes.len().saturating_sub(2_048);
    if !bytes[tail_start..]
        .windows(5)
        .any(|window| window == b"%%EOF")
    {
        return Err("The invoice PDF is incomplete and was not opened for printing.".to_string());
    }
    if !bytes.windows(9).any(|window| window == b"/Contents")
        || !bytes.windows(6).any(|window| window == b"stream")
    {
        return Err("The invoice PDF has no printable page content.".to_string());
    }
    let page_count = pdf_page_count(bytes);
    if page_count == 0 || page_count != expected_page_count {
        return Err(format!(
            "The invoice PDF page count changed during native validation (expected {expected_page_count}, found {page_count})."
        ));
    }
    Ok(page_count)
}

fn unique_pdf_print_path(directory: &Path, filename: &str) -> PathBuf {
    let safe_name = safe_extension(&sanitize_filename(filename, "Invoice.pdf"), "pdf");
    let stem = safe_name.strip_suffix(".pdf").unwrap_or("Invoice");
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|_| format!("{}-{}", unix_timestamp(), std::process::id()));
    directory.join(format!("{stem}-{unique}.pdf"))
}

fn cleanup_stale_pdf_print_files(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut files = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("pdf"))
        .filter_map(|path| {
            let modified = fs::metadata(&path).ok()?.modified().ok()?;
            Some((path, modified))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| right.1.cmp(&left.1));
    let now = SystemTime::now();
    for (index, (path, modified)) in files.into_iter().enumerate() {
        let expired = now
            .duration_since(modified)
            .is_ok_and(|age| age.as_secs() > 24 * 60 * 60);
        if index >= 24 || expired {
            let _ = fs::remove_file(path);
        }
    }
}

fn open_validated_pdf_with_native_print_dialog<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &Path,
    bytes: Vec<u8>,
) -> Result<NativePrintLaunch, String> {
    #[cfg(target_os = "macos")]
    {
        let session_id = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        );
        let log_path = startup_log_path(app);
        append_pdf_print_lifecycle_log(&log_path, &session_id, "Print entered; session created");
        let main_window = app
            .get_webview_window("main")
            .ok_or_else(|| "The Bezgrow window is unavailable for native printing.".to_string())?;
        let callback_app = app.clone();
        let callback_session_id = session_id.clone();
        let callback_log_path = log_path.clone();
        main_window
            .with_webview(move |platform_webview| {
                let result = (|| unsafe {
                    let mtm = MainThreadMarker::new().ok_or_else(|| {
                        "The macOS print panel must be opened on the main thread.".to_string()
                    })?;
                    let data = NSData::with_bytes(&bytes);
                    let document = PDFDocument::initWithData(mtm.alloc::<PDFDocument>(), &data)
                        .ok_or_else(|| {
                            "PDFKit could not load the validated invoice PDF.".to_string()
                        })?;
                    append_pdf_print_lifecycle_log(
                        &callback_log_path,
                        &callback_session_id,
                        "PDF created",
                    );
                    if !document.allowsPrinting() {
                        return Err("The invoice PDF does not permit printing.".to_string());
                    }
                    let print_info = NSPrintInfo::sharedPrintInfo();
                    let operation = document
                        .printOperationForPrintInfo_scalingMode_autoRotate(
                            Some(&print_info),
                            PDFPrintScalingMode::PageScaleDownToFit,
                            true,
                            mtm,
                        )
                        .ok_or_else(|| {
                            "PDFKit could not create the native invoice print operation."
                                .to_string()
                        })?;
                    operation.setShowsPrintPanel(true);
                    operation.setShowsProgressPanel(true);
                    operation.setCanSpawnSeparateThread(true);
                    let window: &NSWindow = &*platform_webview.ns_window().cast();
                    if !objc2::ffi::objc_getAssociatedObject(
                        (window as *const NSWindow).cast(),
                        (&PDF_PRINT_LIFECYCLE_ASSOCIATION_KEY as *const u8).cast(),
                    )
                    .is_null()
                    {
                        return Err(
                            "A native print dialog is already open for this window.".to_string()
                        );
                    }

                    // `runOperationModalForWindow` is modeless and returns immediately.
                    // Root one lifecycle owner on the parent window before launching it;
                    // that owner strongly retains the complete PDFKit/AppKit print graph.
                    // Its completion selector removes this association, releasing the
                    // document, print info, operation, and delegate exactly once.
                    let lifecycle = PdfPrintLifecycle::new(
                        mtm,
                        document,
                        print_info,
                        operation,
                        window,
                        callback_session_id.clone(),
                        callback_log_path.clone(),
                    );
                    objc2::ffi::objc_setAssociatedObject(
                        (window as *const NSWindow).cast_mut().cast(),
                        (&PDF_PRINT_LIFECYCLE_ASSOCIATION_KEY as *const u8).cast(),
                        (Retained::as_ptr(&lifecycle) as *mut PdfPrintLifecycle).cast(),
                        objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
                    );
                    let active = ACTIVE_PDF_PRINT_SESSIONS.fetch_add(1, Ordering::SeqCst) + 1;
                    append_pdf_print_lifecycle_log(
                        &callback_log_path,
                        &callback_session_id,
                        format!(
                            "PDF retained; NSPrintOperation retained; active_sessions={active}"
                        ),
                    );
                    let delegate: &AnyObject =
                        &*(Retained::as_ptr(&lifecycle) as *const PdfPrintLifecycle).cast();
                    let operation = lifecycle.ivars().operation.borrow();
                    operation
                        .as_ref()
                        .ok_or_else(|| {
                            "The native print operation was released before launch.".to_string()
                        })?
                        .runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                            window,
                            Some(delegate),
                            Some(sel!(printOperationDidRun:success:contextInfo:)),
                            std::ptr::null_mut(),
                        );
                    append_pdf_print_lifecycle_log(
                        &callback_log_path,
                        &callback_session_id,
                        "Dialog opened",
                    );
                    Ok(())
                })();
                if let Err(error) = result {
                    append_pdf_print_lifecycle_log(
                        &callback_log_path,
                        &callback_session_id,
                        format!("Native print launch failed: {error}"),
                    );
                    append_startup_log_handle(
                        &callback_app,
                        format!("macOS system print dialog failed: {error}"),
                    );
                }
            })
            .map_err(|error| format!("Unable to open the macOS system print dialog: {error}"))?;
        let _ = path;
        return Ok(NativePrintLaunch {
            status: "dialog_opened",
        });
    }

    #[cfg(target_os = "windows")]
    {
        let url = tauri::Url::from_file_path(path)
            .map_err(|_| "Unable to convert the invoice PDF path into a local URL.".to_string())?;
        if let Some(window) = app.get_webview_window("invoice-native-print") {
            window.navigate(url).map_err(|error| {
                format!("Unable to load the invoice in the native print bridge: {error}")
            })?;
            return Ok(NativePrintLaunch {
                status: "dialog_opened",
            });
        }

        let print_app = app.clone();
        let builder = tauri::WebviewWindowBuilder::new(
            app,
            "invoice-native-print",
            WebviewUrl::External(url),
        )
        .title("Bezgrow Native Invoice Print")
        .inner_size(1.0, 1.0)
        .visible(false)
        .skip_taskbar(true)
        .decorations(false)
        .resizable(false)
        .on_page_load(move |window, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            let callback_app = print_app.clone();
            let schedule_result = window.with_webview(move |platform_webview| {
                let print_result = (|| unsafe {
                    let controller = platform_webview.controller();
                    let webview = controller.CoreWebView2().map_err(|error| {
                        format!("Unable to access the WebView2 document: {error}")
                    })?;
                    let print_webview: ICoreWebView2_16 = webview.cast().map_err(|error| {
                        format!(
                            "This WebView2 runtime does not support the system print UI: {error}"
                        )
                    })?;
                    print_webview
                        .ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM)
                        .map_err(|error| {
                            format!("Windows could not open the system print dialog: {error}")
                        })?;
                    Ok::<(), String>(())
                })();
                match print_result {
                    Ok(()) => append_startup_log_handle(
                        &callback_app,
                        "Windows system print dialog opened for the validated invoice PDF",
                    ),
                    Err(error) => append_startup_log_handle(
                        &callback_app,
                        format!("Windows system print dialog failed: {error}"),
                    ),
                }
            });
            if let Err(error) = schedule_result {
                append_startup_log_handle(
                    &print_app,
                    format!("Unable to schedule the Windows native print dialog: {error}"),
                );
            }
        });
        let builder = builder.data_directory(managed_data_directory(app, "WebViewInvoicePrint")?);
        builder.build().map_err(|error| {
            format!("Unable to create the Windows native print bridge: {error}")
        })?;
        let _ = bytes;
        return Ok(NativePrintLaunch {
            status: "dialog_opened",
        });
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, path, bytes);
        Err(
            "The native invoice print dialog is supported on macOS and Windows desktop builds."
                .to_string(),
        )
    }
}

#[tauri::command]
async fn desktop_open_pdf_for_print<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    filename: String,
    bytes: Vec<u8>,
    expected_page_count: usize,
) -> Result<DesktopOpenedPdf, String> {
    let operation = begin_critical_operation(&app)?;
    validate_pdf_for_native_open(&bytes, expected_page_count)?;
    let directory = managed_data_directory(&app, "Temp")?.join("PDF Print");
    fs::create_dir_all(&directory).map_err(|error| {
        format!("Unable to create Bezgrow's temporary PDF print folder: {error}")
    })?;
    cleanup_stale_pdf_print_files(&directory);
    let destination = unique_pdf_print_path(&directory, &filename);
    let temporary = destination.with_extension("pdf.tmp");

    let write_result = (|| {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("Unable to prepare the invoice PDF for printing: {error}"))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("Unable to finish the invoice PDF for printing: {error}"))?;
        fs::rename(&temporary, &destination)
            .map_err(|error| format!("Unable to publish the temporary invoice PDF: {error}"))?;
        Ok::<(), String>(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result?;

    let written = fs::read(&destination)
        .map_err(|error| format!("Unable to reopen the temporary invoice PDF: {error}"))?;
    let written_page_count = validate_pdf_for_native_open(&written, expected_page_count)?;
    if written != bytes {
        return Err("The temporary invoice PDF bytes changed after writing.".to_string());
    }
    let print_launch =
        open_validated_pdf_with_native_print_dialog(&app, &destination, written.clone())?;
    drop(operation);
    append_startup_log_handle(
        &app,
        format!(
            "Validated invoice PDF passed to native print UI; status={}",
            print_launch.status
        ),
    );

    let print_status = print_launch.status;

    append_startup_log_handle(
        &app,
        format!("Native print command returning status={print_status}"),
    );

    Ok(DesktopOpenedPdf {
        path: destination.to_string_lossy().to_string(),
        filename: destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Invoice.pdf")
            .to_string(),
        bytes: written.len() as u64,
        page_count: written_page_count,
        status: print_status,
    })
}

async fn create_consistent_database_snapshot(
    database_path: &Path,
    snapshot_path: &Path,
) -> Result<(), String> {
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(std::time::Duration::from_secs(10));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open SQLite for backup: {error}"))?;
    sqlx::query("PRAGMA wal_checkpoint(FULL)")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Unable to checkpoint SQLite before backup: {error}"))?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Unable to lock SQLite for a consistent backup: {error}"))?;
    let copy_result = fs::copy(database_path, snapshot_path)
        .map(|_| ())
        .map_err(|error| format!("Unable to copy SQLite into the backup package: {error}"));
    let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
    copy_result
}

fn collect_asset_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if !current.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(current)
        .map_err(|error| format!("Unable to read Bezgrow's local assets: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect a local asset: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_asset_files(root, &path, files)?;
        } else if path.is_file() && path.strip_prefix(root).is_ok() {
            files.push(path);
        }
    }
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("Unable to create a restore asset folder: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Unable to read a restore asset folder: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect a restore asset: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if source_path.is_file() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Unable to restore a business asset: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn copy_directory_missing(source: &Path, destination: &Path) -> Result<usize, String> {
    if !source.exists() {
        return Ok(0);
    }
    let mut copied = 0_usize;
    fs::create_dir_all(destination)
        .map_err(|error| format!("Unable to create a migrated data folder: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Unable to read a previous Bezgrow data folder: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Unable to inspect previous Bezgrow data: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copied += copy_directory_missing(&source_path, &destination_path)?;
        } else if source_path.is_file() && !destination_path.exists() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Unable to migrate previous Bezgrow data: {error}"))?;
            copied += 1;
        }
    }
    Ok(copied)
}

#[cfg(any(target_os = "windows", test))]
fn copy_directory_missing_without_sqlite(
    source: &Path,
    destination: &Path,
) -> Result<usize, String> {
    if !source.exists() {
        return Ok(0);
    }
    let mut copied = 0_usize;
    fs::create_dir_all(destination)
        .map_err(|error| format!("Unable to create a migrated data folder: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Unable to read a previous Bezgrow data folder: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Unable to inspect previous Bezgrow data: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copied += copy_directory_missing_without_sqlite(&source_path, &destination_path)?;
        } else if source_path.is_file() {
            let filename = entry.file_name();
            let filename = filename.to_string_lossy();
            if filename == LOCAL_DATABASE_NAME
                || filename == format!("{LOCAL_DATABASE_NAME}-wal")
                || filename == format!("{LOCAL_DATABASE_NAME}-shm")
            {
                continue;
            }
            if !destination_path.exists() {
                fs::copy(&source_path, &destination_path)
                    .map_err(|error| format!("Unable to migrate previous Bezgrow data: {error}"))?;
                copied += 1;
            }
        }
    }
    Ok(copied)
}

fn quoted_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quoted_sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

async fn sqlite_schema_version(database_path: &Path) -> Result<i64, String> {
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(10));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open the backup database: {error}"))?;
    sqlx::query_scalar::<_, i64>("PRAGMA user_version")
        .fetch_one(&mut connection)
        .await
        .map_err(|error| format!("Unable to read the backup schema version: {error}"))
}

async fn verify_accounting_integrity(
    connection: &mut SqliteConnection,
    context: &str,
) -> Result<(), String> {
    let accounting_tables = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name IN ('accounting_vouchers', 'accounting_voucher_entries', 'financial_years')",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| format!("Unable to inspect {context} accounting schema: {error}"))?;
    if accounting_tables != 3 {
        return Ok(());
    }

    let invalid_postings = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*)
         FROM accounting_vouchers voucher
         LEFT JOIN financial_years year
           ON year.id = voucher.financial_year_id AND year.organization_id = voucher.organization_id
         LEFT JOIN (
           SELECT voucher_id, organization_id, COUNT(*) AS line_count,
             COALESCE(SUM(debit_minor), 0) AS debit_minor,
             COALESCE(SUM(credit_minor), 0) AS credit_minor,
             SUM(CASE WHEN debit_minor < 0 OR credit_minor < 0
                       OR (debit_minor = 0 AND credit_minor = 0)
                       OR (debit_minor > 0 AND credit_minor > 0)
                       OR typeof(debit_minor) <> 'integer' OR typeof(credit_minor) <> 'integer'
                      THEN 1 ELSE 0 END) AS invalid_lines
           FROM accounting_voucher_entries GROUP BY voucher_id, organization_id
         ) totals ON totals.voucher_id = voucher.id AND totals.organization_id = voucher.organization_id
         WHERE voucher.status = 'posted' AND (
           year.id IS NULL OR voucher.voucher_date < year.start_date OR voucher.voucher_date > year.end_date
           OR COALESCE(totals.line_count, 0) < 2 OR COALESCE(totals.invalid_lines, 0) > 0
           OR totals.debit_minor <= 0 OR totals.debit_minor <> totals.credit_minor
           OR totals.debit_minor <> voucher.total_debit_minor
           OR totals.credit_minor <> voucher.total_credit_minor
         )",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| format!("Unable to verify {context} accounting journals: {error}"))?;
    let duplicate_sources = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM (
           SELECT organization_id, source_type, source_id
           FROM accounting_vouchers
           WHERE status = 'posted' AND source_type IS NOT NULL AND source_id IS NOT NULL
           GROUP BY organization_id, source_type, source_id HAVING COUNT(*) > 1
         )",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| format!("Unable to verify {context} accounting source identities: {error}"))?;
    if invalid_postings > 0 || duplicate_sources > 0 {
        return Err(format!(
            "The {context} contains invalid accounting data ({invalid_postings} broken journals, {duplicate_sources} duplicate sources)."
        ));
    }
    Ok(())
}

async fn verify_backup_database(
    database_path: &Path,
    organization_id: &str,
) -> Result<i64, String> {
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(10));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open the backup database: {error}"))?;
    let quick = sqlx::query_scalar::<_, String>("PRAGMA quick_check")
        .fetch_one(&mut connection)
        .await
        .map_err(|error| format!("Unable to run the backup integrity check: {error}"))?;
    if !quick.eq_ignore_ascii_case("ok") {
        return Err(format!(
            "The backup database failed its integrity check: {quick}"
        ));
    }
    let foreign_keys = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut connection)
        .await
        .map_err(|error| format!("Unable to verify backup relationships: {error}"))?;
    if !foreign_keys.is_empty() {
        return Err("The backup contains invalid database relationships.".to_string());
    }
    verify_accounting_integrity(&mut connection, "backup").await?;
    let business_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM organizations WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(organization_id)
    .fetch_one(&mut connection)
    .await
    .map_err(|error| format!("Unable to verify the backup business identity: {error}"))?;
    if business_count != 1 {
        return Err("This backup does not belong to the active business.".to_string());
    }
    sqlx::query_scalar::<_, i64>("PRAGMA user_version")
        .fetch_one(&mut connection)
        .await
        .map_err(|error| format!("Unable to read the backup schema version: {error}"))
}

async fn restore_database_contents(
    current_database: &Path,
    backup_database: &Path,
) -> Result<(), String> {
    let options = SqliteConnectOptions::new()
        .filename(current_database)
        .create_if_missing(false)
        .foreign_keys(false)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(std::time::Duration::from_secs(10));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open the active database for restore: {error}"))?;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Unable to prepare the restore transaction: {error}"))?;
    sqlx::query("ATTACH DATABASE ? AS restore_db")
        .bind(backup_database.to_string_lossy().to_string())
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Unable to attach the verified backup: {error}"))?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Unable to begin the restore transaction: {error}"))?;

    let restore_result: Result<(), String> = async {
        let current_tables = sqlx::query_scalar::<_, String>(
            "SELECT name FROM main.sqlite_master
             WHERE type = 'table'
               AND name NOT LIKE 'sqlite_%'
               AND name NOT IN ('schema_migrations', 'license_state', 'device_activations')",
        )
        .fetch_all(&mut connection)
        .await
        .map_err(|error| format!("Unable to inspect active database tables: {error}"))?;
        let backup_tables: HashSet<String> = sqlx::query_scalar::<_, String>(
            "SELECT name FROM restore_db.sqlite_master WHERE type = 'table'",
        )
        .fetch_all(&mut connection)
        .await
        .map_err(|error| format!("Unable to inspect backup database tables: {error}"))?
        .into_iter()
        .collect();

        for table in &current_tables {
            let quoted_table = quoted_identifier(table);
            sqlx::query(&format!("DELETE FROM main.{quoted_table}"))
                .execute(&mut connection)
                .await
                .map_err(|error| format!("Unable to clear {table} during restore: {error}"))?;
            if !backup_tables.contains(table) {
                continue;
            }

            let current_columns = sqlx::query_scalar::<_, String>(&format!(
                "SELECT name FROM pragma_table_info({}, 'main')",
                quoted_sql_string(table)
            ))
            .fetch_all(&mut connection)
            .await
            .map_err(|error| format!("Unable to inspect active {table} columns: {error}"))?;
            let backup_columns: HashSet<String> = sqlx::query_scalar::<_, String>(&format!(
                "SELECT name FROM pragma_table_info({}, 'restore_db')",
                quoted_sql_string(table)
            ))
            .fetch_all(&mut connection)
            .await
            .map_err(|error| format!("Unable to inspect backup {table} columns: {error}"))?
            .into_iter()
            .collect();
            let shared_columns: Vec<String> = current_columns
                .into_iter()
                .filter(|column| backup_columns.contains(column))
                .collect();
            if shared_columns.is_empty() {
                continue;
            }
            let columns = shared_columns
                .iter()
                .map(|column| quoted_identifier(column))
                .collect::<Vec<_>>()
                .join(", ");
            sqlx::query(&format!(
                "INSERT INTO main.{quoted_table} ({columns})
                 SELECT {columns} FROM restore_db.{quoted_table}"
            ))
            .execute(&mut connection)
            .await
            .map_err(|error| format!("Unable to restore {table}: {error}"))?;
        }

        let foreign_key_rows = sqlx::query("PRAGMA main.foreign_key_check")
            .fetch_all(&mut connection)
            .await
            .map_err(|error| format!("Unable to validate restored relationships: {error}"))?;
        if !foreign_key_rows.is_empty() {
            return Err("The restored database would contain invalid relationships.".to_string());
        }
        verify_accounting_integrity(&mut connection, "restored database").await?;
        Ok(())
    }
    .await;

    match restore_result {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut connection)
                .await
                .map_err(|error| format!("Unable to commit the restore transaction: {error}"))?;
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
            let _ = sqlx::query("DETACH DATABASE restore_db")
                .execute(&mut connection)
                .await;
            return Err(error);
        }
    }
    sqlx::query("DETACH DATABASE restore_db")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Unable to finish the restore operation: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn desktop_export_backup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    organization_id: String,
    filename: String,
) -> Result<Option<DesktopSavedFile>, String> {
    let _operation = begin_critical_operation(&app)?;
    let safe_filename = safe_extension(
        &sanitize_filename(&filename, "bezgrow-backup.bezgrow-backup"),
        "bezgrow-backup",
    );
    let backup_directory = managed_data_directory(&app, "Backups")?;
    fs::create_dir_all(&backup_directory)
        .map_err(|error| format!("Unable to create Bezgrow's backup folder: {error}"))?;
    let destination = rfd::FileDialog::new()
        .set_directory(&backup_directory)
        .set_file_name(&safe_filename)
        .add_filter("Bezgrow backup", &["bezgrow-backup"])
        .save_file();
    let Some(destination) = destination else {
        return Ok(None);
    };

    let database_path = local_database_path(&app)?;
    let app_data = managed_app_data_root(&app)?;
    let staging = app_data
        .join("Temporary")
        .join(format!("export-staging-{}", unix_timestamp()));
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Unable to create the backup staging folder: {error}"))?;
    let snapshot = staging.join("database.sqlite");
    create_consistent_database_snapshot(&database_path, &snapshot).await?;
    let schema_version = verify_backup_database(&snapshot, &organization_id).await?;
    let database_checksum_sha256 = sha256_file(&snapshot)?;
    let database_bytes = fs::metadata(&snapshot)
        .map_err(|error| format!("Unable to inspect the database snapshot: {error}"))?
        .len();

    let asset_root = app_data.join("business-assets");
    let mut asset_files = Vec::new();
    collect_asset_files(&app_data, &asset_root, &mut asset_files)?;
    let mut assets = Vec::new();
    for asset in &asset_files {
        let relative = asset
            .strip_prefix(&app_data)
            .map_err(|_| "Unable to package a local business asset.".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        assets.push(BackupAssetManifest {
            relative_path: relative,
            checksum_sha256: sha256_file(asset)?,
            bytes: fs::metadata(asset)
                .map_err(|error| format!("Unable to inspect a local business asset: {error}"))?
                .len(),
        });
    }
    let manifest = DesktopBackupManifest {
        app: "Bezgrow".to_string(),
        format_version: 1,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version,
        organization_id,
        created_at: unix_timestamp(),
        database_checksum_sha256,
        database_bytes,
        assets,
    };

    let temporary_package = staging.join("package.tmp");
    let package_file = fs::File::create(&temporary_package)
        .map_err(|error| format!("Unable to create the backup package: {error}"))?;
    let mut archive = zip::ZipWriter::new(package_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    archive
        .start_file("manifest.json", options)
        .map_err(|error| format!("Unable to write the backup manifest: {error}"))?;
    archive
        .write_all(
            serde_json::to_string_pretty(&manifest)
                .map_err(|error| format!("Unable to encode the backup manifest: {error}"))?
                .as_bytes(),
        )
        .map_err(|error| format!("Unable to write the backup manifest: {error}"))?;
    archive
        .start_file("database.sqlite", options)
        .map_err(|error| format!("Unable to add SQLite to the backup package: {error}"))?;
    let mut database_file = fs::File::open(&snapshot)
        .map_err(|error| format!("Unable to read the database snapshot: {error}"))?;
    std::io::copy(&mut database_file, &mut archive)
        .map_err(|error| format!("Unable to package the database snapshot: {error}"))?;
    for (asset, asset_manifest) in asset_files.iter().zip(manifest.assets.iter()) {
        archive
            .start_file(format!("assets/{}", asset_manifest.relative_path), options)
            .map_err(|error| format!("Unable to add a business asset to the backup: {error}"))?;
        let mut file = fs::File::open(asset)
            .map_err(|error| format!("Unable to read a business asset: {error}"))?;
        std::io::copy(&mut file, &mut archive)
            .map_err(|error| format!("Unable to package a business asset: {error}"))?;
    }
    archive
        .finish()
        .map_err(|error| format!("Unable to finish the backup package: {error}"))?;

    let parent = destination
        .parent()
        .ok_or_else(|| "The selected backup destination is invalid.".to_string())?;
    if !parent.exists() {
        return Err("The selected backup destination no longer exists.".to_string());
    }
    let destination_temporary = parent.join(format!(".{}.{}.tmp", safe_filename, unix_timestamp()));
    fs::copy(&temporary_package, &destination_temporary)
        .map_err(|error| format!("Unable to copy the backup package: {error}"))?;
    if let Err(initial_error) = fs::rename(&destination_temporary, &destination) {
        let replacement_result = if destination.exists() {
            fs::remove_file(&destination)
                .and_then(|()| fs::rename(&destination_temporary, &destination))
        } else {
            Err(initial_error)
        };
        if let Err(error) = replacement_result {
            let _ = fs::remove_file(&destination_temporary);
            return Err(format!("Unable to save the backup package: {error}"));
        }
    }
    let result = DesktopSavedFile {
        path: destination.to_string_lossy().to_string(),
        filename: destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&safe_filename)
            .to_string(),
        bytes: fs::metadata(&destination)
            .map_err(|error| format!("Unable to verify the backup package: {error}"))?
            .len(),
    };
    let _ = fs::remove_dir_all(&staging);
    Ok(Some(result))
}

#[tauri::command]
async fn desktop_restore_backup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    organization_id: String,
) -> Result<Option<DesktopRestoreResult>, String> {
    let _operation = begin_critical_operation(&app)?;
    let backup_directory = managed_data_directory(&app, "Backups")?;
    fs::create_dir_all(&backup_directory)
        .map_err(|error| format!("Unable to create Bezgrow's backup folder: {error}"))?;
    let source = rfd::FileDialog::new()
        .set_directory(&backup_directory)
        .add_filter("Bezgrow backup", &["bezgrow-backup"])
        .pick_file();
    let Some(source) = source else {
        return Ok(None);
    };
    let package_bytes = fs::metadata(&source)
        .map_err(|error| format!("Unable to inspect the selected backup: {error}"))?
        .len();
    if package_bytes == 0 || package_bytes > MAX_BACKUP_PACKAGE_BYTES {
        return Err(
            "The selected backup package is empty or exceeds the supported size.".to_string(),
        );
    }
    let app_data = managed_app_data_root(&app)?;
    let staging = app_data
        .join("Temporary")
        .join(format!("restore-staging-{}", unix_timestamp()));
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Unable to create the restore staging folder: {error}"))?;

    let package = fs::File::open(&source)
        .map_err(|error| format!("Unable to open the selected backup: {error}"))?;
    let mut archive = zip::ZipArchive::new(package)
        .map_err(|_| "The selected file is not a valid Bezgrow backup package.".to_string())?;
    let manifest: DesktopBackupManifest = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| "The backup manifest is missing.".to_string())?;
        if entry.size() == 0 || entry.size() > MAX_BACKUP_MANIFEST_BYTES {
            return Err("The backup manifest is empty or exceeds the supported size.".to_string());
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Unable to read the backup manifest: {error}"))?;
        serde_json::from_slice(&bytes).map_err(|_| "The backup manifest is damaged.".to_string())?
    };
    if manifest.app != "Bezgrow"
        || manifest.format_version != 1
        || manifest.app_version.trim().is_empty()
    {
        return Err("This is not a compatible Bezgrow backup package.".to_string());
    }
    if manifest.organization_id != organization_id {
        return Err("This backup belongs to a different business/workspace.".to_string());
    }
    if manifest.database_bytes == 0
        || manifest.database_bytes > MAX_BACKUP_DATABASE_BYTES
        || !is_sha256(&manifest.database_checksum_sha256)
        || manifest.assets.len() > MAX_BACKUP_ASSET_COUNT
    {
        return Err("The backup manifest contains invalid database or asset limits.".to_string());
    }
    let mut declared_asset_bytes = 0_u64;
    let mut declared_asset_paths = HashSet::new();
    for asset in &manifest.assets {
        declared_asset_bytes = declared_asset_bytes
            .checked_add(asset.bytes)
            .ok_or_else(|| "The backup asset sizes are invalid.".to_string())?;
        if asset.bytes > MAX_BACKUP_ASSET_BYTES
            || declared_asset_bytes > MAX_BACKUP_ASSET_TOTAL_BYTES
            || !is_sha256(&asset.checksum_sha256)
            || !declared_asset_paths.insert(asset.relative_path.clone())
        {
            return Err("The backup manifest contains invalid or duplicate assets.".to_string());
        }
    }

    let backup_database = staging.join("database.sqlite");
    {
        let mut entry = archive
            .by_name("database.sqlite")
            .map_err(|_| "The backup database is missing.".to_string())?;
        if entry.size() != manifest.database_bytes {
            return Err("The backup database size does not match its manifest.".to_string());
        }
        let mut output = fs::File::create(&backup_database)
            .map_err(|error| format!("Unable to prepare the backup database: {error}"))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Unable to extract the backup database: {error}"))?;
    }
    if sha256_file(&backup_database)? != manifest.database_checksum_sha256 {
        return Err("The backup database checksum does not match its manifest.".to_string());
    }
    let current_database = local_database_path(&app)?;
    let current_schema = sqlite_schema_version(&current_database).await?;
    let backup_schema = verify_backup_database(&backup_database, &organization_id).await?;
    if backup_schema > current_schema || backup_schema != manifest.schema_version {
        return Err(format!(
            "The backup schema is not compatible with this Bezgrow version (backup {backup_schema}, installed {current_schema})."
        ));
    }

    let extracted_assets = staging.join("business-assets");
    for asset in &manifest.assets {
        let entry_name = format!("assets/{}", asset.relative_path);
        let mut entry = archive.by_name(&entry_name).map_err(|_| {
            format!(
                "A required backup asset is missing: {}",
                asset.relative_path
            )
        })?;
        if entry.size() != asset.bytes {
            return Err(format!(
                "A backup asset size does not match its manifest: {}",
                asset.relative_path
            ));
        }
        let relative = Path::new(&asset.relative_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            || !asset.relative_path.starts_with("business-assets/")
        {
            return Err("The backup contains an unsafe asset path.".to_string());
        }
        let trimmed_relative = relative
            .strip_prefix("business-assets")
            .map_err(|_| "The backup contains an invalid asset path.".to_string())?;
        let destination = extracted_assets.join(trimmed_relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Unable to create a restore asset folder: {error}"))?;
        }
        let mut output = fs::File::create(&destination)
            .map_err(|error| format!("Unable to extract a backup asset: {error}"))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Unable to extract a backup asset: {error}"))?;
        if sha256_file(&destination)? != asset.checksum_sha256 {
            return Err(format!(
                "A backup asset checksum does not match: {}",
                asset.relative_path
            ));
        }
    }

    let pre_restore = app_data
        .join("Backups")
        .join(format!("pre-restore-{}.db", unix_timestamp()));
    create_consistent_database_snapshot(&current_database, &pre_restore).await?;
    let active_assets = app_data.join("business-assets");
    let pre_restore_assets = app_data
        .join("Backups")
        .join(format!("pre-restore-assets-{}", unix_timestamp()));
    if active_assets.exists() {
        copy_directory(&active_assets, &pre_restore_assets)?;
    }
    if active_assets.exists() {
        fs::remove_dir_all(&active_assets)
            .map_err(|error| format!("Unable to prepare business assets for restore: {error}"))?;
    }
    if let Err(error) = copy_directory(&extracted_assets, &active_assets) {
        let _ = fs::remove_dir_all(&active_assets);
        let _ = copy_directory(&pre_restore_assets, &active_assets);
        return Err(error);
    }

    if let Err(error) = restore_database_contents(&current_database, &backup_database).await {
        let _ = fs::remove_dir_all(&active_assets);
        let _ = copy_directory(&pre_restore_assets, &active_assets);
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = verify_backup_database(&current_database, &organization_id).await {
        let rollback_result = restore_database_contents(&current_database, &pre_restore).await;
        let _ = fs::remove_dir_all(&active_assets);
        let _ = copy_directory(&pre_restore_assets, &active_assets);
        let _ = fs::remove_dir_all(&staging);
        return match rollback_result {
            Ok(()) => Err(format!("The restored database failed verification and was rolled back: {error}")),
            Err(rollback_error) => Err(format!("The restored database failed verification ({error}) and the safety rollback also failed ({rollback_error}).")),
        };
    }
    let _ = fs::remove_dir_all(&staging);
    Ok(Some(DesktopRestoreResult {
        backup_path: source.to_string_lossy().to_string(),
        pre_restore_backup_path: pre_restore.to_string_lossy().to_string(),
        schema_version: backup_schema,
        organization_id,
    }))
}

#[tauri::command]
fn desktop_database_diagnostics<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<DesktopDatabaseDiagnostics, String> {
    append_startup_log_handle(&app, "SQLite native diagnostics invoked");
    let app_data_dir = managed_app_data_root(&app)?;
    let app_config_dir = local_database_path(&app)?
        .parent()
        .ok_or_else(|| "Unable to resolve desktop database directory.".to_string())?
        .to_path_buf();
    let database_path = app_config_dir.join(LOCAL_DATABASE_NAME);
    let parent_existed = app_config_dir.is_dir();

    fs::create_dir_all(&app_config_dir)
        .map_err(|error| format!("Unable to create desktop database directory: {error}"))?;
    if !database_path.exists() {
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&database_path)
            .map_err(|error| format!("Unable to create the desktop database file: {error}"))?;
    }

    let probe_path = app_config_dir.join(".bezgrow-write-probe");
    let parent_writable = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&probe_path)
        .and_then(|mut file| file.write_all(b"ok"))
        .is_ok();
    let _ = fs::remove_file(&probe_path);

    let metadata = fs::metadata(&database_path).ok();
    let device_id_path =
        managed_data_directory(&app, INSTALLATION_DIRECTORY)?.join(DEVICE_ID_FILENAME);
    let migration = app.try_state::<ManagedDataPreparation>();

    Ok(DesktopDatabaseDiagnostics {
        application_version: app.package_info().version.to_string(),
        app_config_dir: app_config_dir.to_string_lossy().to_string(),
        app_data_dir: app_data_dir.to_string_lossy().to_string(),
        database_path: database_path.to_string_lossy().to_string(),
        device_id_source: if device_id_path.is_file() {
            "canonical-installation-file".to_string()
        } else {
            "not-yet-persisted".to_string()
        },
        license_state_source: if metadata.as_ref().map(|value| value.len()).unwrap_or(0) > 0 {
            "sqlite:license_state".to_string()
        } else {
            "not-yet-initialized".to_string()
        },
        legacy_migration_occurred: migration
            .as_ref()
            .map(|value| value.legacy_migration_occurred)
            .unwrap_or(false),
        legacy_migration_source: migration
            .as_ref()
            .and_then(|value| value.legacy_migration_source.clone()),
        parent_exists: app_config_dir.exists(),
        parent_created: !parent_existed && app_config_dir.exists(),
        parent_writable,
        database_exists: metadata.is_some(),
        database_bytes: metadata.map(|value| value.len()).unwrap_or(0),
    })
}

#[tauri::command]
async fn desktop_database_backup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    reason: Option<String>,
) -> Result<Option<DesktopDatabaseBackup>, String> {
    let _operation = begin_critical_operation(&app)?;
    let database_path = local_database_path(&app)?;
    if !database_path.exists() {
        return Ok(None);
    }

    let backup_dir = managed_data_directory(&app, "Backups")?;
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("Unable to create desktop backup directory: {error}"))?;

    let safe_reason = reason
        .unwrap_or_else(|| "migration".to_string())
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    let created_at = unix_timestamp();
    let backup_path = backup_dir.join(format!(
        "bezgrow-offline-{}-{}.db",
        safe_reason.trim_matches('-'),
        created_at
    ));

    create_consistent_database_snapshot(&database_path, &backup_path).await?;
    let metadata = fs::metadata(&backup_path)
        .map_err(|error| format!("Unable to inspect desktop database backup: {error}"))?;
    let checksum_sha256 = sha256_file(&backup_path)?;

    Ok(Some(DesktopDatabaseBackup {
        backup_path: backup_path.to_string_lossy().to_string(),
        checksum_sha256,
        bytes: metadata.len(),
        created_at,
    }))
}

#[tauri::command]
async fn desktop_prepare_update<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    unsaved_work: bool,
) -> Result<DesktopUpdatePreflight, String> {
    if unsaved_work {
        return Err("The update is waiting because Bezgrow has unsaved work or a billing operation in progress.".to_string());
    }
    let state = app.state::<DesktopOperationState>();
    if state
        .update_preparing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("An update is already being prepared.".to_string());
    }
    if state.active_critical_operations.load(Ordering::SeqCst) != 0 {
        state.update_preparing.store(false, Ordering::SeqCst);
        return Err("The update is waiting for the current invoice, print, database write, backup, restore, migration, or export to finish.".to_string());
    }
    let result = async {
        let database_path = local_database_path(&app)?;
        if !database_path.exists() {
            return Ok(DesktopUpdatePreflight {
                integrity: "database-not-created".to_string(),
                foreign_key_violations: 0,
                backup: None,
            });
        }
        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(std::time::Duration::from_secs(10));
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(|error| format!("Unable to open SQLite for the pre-update integrity check: {error}"))?;
        let integrity = sqlx::query_scalar::<_, String>("PRAGMA quick_check")
            .fetch_one(&mut connection)
            .await
            .map_err(|error| format!("Unable to run the pre-update SQLite integrity check: {error}"))?;
        if !integrity.eq_ignore_ascii_case("ok") {
            return Err(format!("The update was cancelled because SQLite integrity is not OK: {integrity}"));
        }
        let foreign_key_violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut connection)
            .await
            .map_err(|error| format!("Unable to run the pre-update relationship check: {error}"))?
            .len();
        connection.close().await.map_err(|error| format!("Unable to close SQLite after the pre-update check: {error}"))?;
        if foreign_key_violations != 0 {
            return Err(format!("The update was cancelled because SQLite has {foreign_key_violations} foreign-key violations."));
        }

        let backup_dir = managed_data_directory(&app, "Backups")?;
        fs::create_dir_all(&backup_dir)
            .map_err(|error| format!("Unable to create the pre-update backup folder: {error}"))?;
        let backup_path = backup_dir.join(format!("bezgrow-offline-pre-update-{}.db", unix_timestamp()));
        create_consistent_database_snapshot(&database_path, &backup_path).await?;
        let metadata = fs::metadata(&backup_path)
            .map_err(|error| format!("Unable to inspect the pre-update backup: {error}"))?;
        let backup = DesktopDatabaseBackup {
            backup_path: backup_path.to_string_lossy().to_string(),
            checksum_sha256: sha256_file(&backup_path)?,
            bytes: metadata.len(),
            created_at: unix_timestamp(),
        };
        append_startup_log_handle(
            &app,
            format!(
                "Pre-update safety check passed: quick_check=ok, foreign_key_violations=0, backup={}, sha256={}",
                backup.backup_path, backup.checksum_sha256
            ),
        );
        Ok(DesktopUpdatePreflight {
            integrity,
            foreign_key_violations,
            backup: Some(backup),
        })
    }
    .await;

    if result.is_err() {
        state.update_preparing.store(false, Ordering::SeqCst);
    }
    result
}

fn normalized_release_architecture(value: &str) -> Option<&'static str> {
    match value.to_ascii_lowercase().as_str() {
        "arm64" | "aarch64" => Some("arm64"),
        "x64" | "x86_64" | "amd64" => Some("x64"),
        _ => None,
    }
}

fn current_release_architecture() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

fn current_release_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "unsupported"
    }
}

fn validate_verified_release_request(
    release: &VerifiedReleaseDownloadRequest,
) -> Result<tauri::Url, String> {
    if !release
        .version
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte == b'.')
        || release.version.split('.').count() != 3
    {
        return Err("The release version is invalid.".to_string());
    }
    if release.platform != current_release_platform() {
        return Err("The release platform does not match this Bezgrow installation.".to_string());
    }
    if normalized_release_architecture(&release.architecture)
        != Some(current_release_architecture())
    {
        return Err("The release architecture does not match this device.".to_string());
    }
    if release.size < 1024 * 1024 || release.size > 2 * 1024 * 1024 * 1024 {
        return Err("The release size is outside the permitted installer range.".to_string());
    }
    if release.sha256.len() != 64 || !release.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The release SHA-256 is invalid.".to_string());
    }
    if !matches!(
        release.trust_state.as_str(),
        "signed-production" | "unsigned-manual-install"
    ) {
        return Err("The release trust state is not installable.".to_string());
    }

    let filename_path = Path::new(&release.filename);
    if filename_path.file_name().and_then(|value| value.to_str()) != Some(release.filename.as_str())
        || release.filename.contains('/')
        || release.filename.contains('\\')
        || !release
            .filename
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.() ".contains(&byte))
    {
        return Err("The release filename is unsafe.".to_string());
    }
    let lower_filename = release.filename.to_ascii_lowercase();
    let allowed_extension = if release.platform == "macos" {
        lower_filename.ends_with(".dmg")
    } else {
        lower_filename.ends_with(".exe")
            || lower_filename.ends_with(".msi")
            || lower_filename.ends_with(".msix")
    };
    if !allowed_extension || !release.filename.contains(&release.version) {
        return Err("The release filename does not match its platform or version.".to_string());
    }

    let parsed =
        tauri::Url::parse(&release.url).map_err(|error| format!("Invalid release URL: {error}"))?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let trusted_host = host == "bezgrow.com" || host.ends_with(".bezgrow.com");
    if parsed.scheme() != "https"
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.port().is_some_and(|port| port != 443)
        || !trusted_host
        || parsed.path() != "/api/downloads/desktop"
    {
        return Err(
            "The assisted update URL is not the trusted Bezgrow release endpoint.".to_string(),
        );
    }
    let expected_platform = if release.platform == "macos" {
        ["mac", "macos"].as_slice()
    } else {
        ["windows"].as_slice()
    };
    let requested_platform = parsed
        .query_pairs()
        .find(|(key, _)| key == "platform")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    if !expected_platform.contains(&requested_platform.as_str()) {
        return Err("The assisted update URL targets the wrong platform.".to_string());
    }
    Ok(parsed)
}

#[tauri::command]
async fn desktop_download_verified_release<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    release: VerifiedReleaseDownloadRequest,
) -> Result<VerifiedReleaseDownload, String> {
    if !app
        .state::<DesktopOperationState>()
        .update_preparing
        .load(Ordering::SeqCst)
    {
        return Err("A database-safe update has not been prepared.".to_string());
    }
    let url = validate_verified_release_request(&release)?;
    let update_directory = managed_data_directory(&app, "Updates")?;
    fs::create_dir_all(&update_directory)
        .map_err(|error| format!("Unable to create the verified update folder: {error}"))?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&update_directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Unable to secure the verified update folder: {error}"))?;
    }

    let unique_name = format!("{}-{}", unix_timestamp(), release.filename);
    let final_path = update_directory.join(unique_name);
    let partial_path = final_path.with_extension(format!(
        "{}.part",
        final_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
    ));
    let result = async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15 * 60))
            .build()
            .map_err(|error| format!("Unable to initialize the verified downloader: {error}"))?;
        let mut response = client
            .get(url)
            .header(
                reqwest::header::ACCEPT,
                "application/octet-stream, application/x-apple-diskimage, application/vnd.microsoft.portable-executable, application/x-msi, application/msix",
            )
            .send()
            .await
            .map_err(|error| format!("Unable to download the verified Bezgrow installer: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "The Bezgrow release endpoint returned HTTP {}.",
                response.status()
            ));
        }
        let headers = response.headers();
        let header_value = |name: &'static str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
        };
        if header_value("x-bezgrow-artifact-version") != release.version
            || header_value("x-bezgrow-artifact-sha256")
                .to_ascii_lowercase()
                != release.sha256.to_ascii_lowercase()
            || normalized_release_architecture(header_value("x-bezgrow-artifact-architecture"))
                != normalized_release_architecture(&release.architecture)
            || header_value("x-bezgrow-release-trust") != release.trust_state
        {
            return Err("The downloaded installer identity does not match release metadata.".to_string());
        }
        if response.content_length().is_some_and(|size| size != release.size) {
            return Err("The downloaded installer size does not match release metadata.".to_string());
        }
        let content_type = header_value("content-type").to_ascii_lowercase();
        if content_type.starts_with("text/")
            || content_type.contains("text/html")
            || content_type.contains("application/json")
        {
            return Err("The release endpoint returned text instead of installer bytes.".to_string());
        }

        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&partial_path)
            .map_err(|error| format!("Unable to create the verified installer file: {error}"))?;
        let mut digest = Sha256::new();
        let mut bytes = 0_u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("The verified installer download was interrupted: {error}"))?
        {
            bytes = bytes.saturating_add(chunk.len() as u64);
            if bytes > release.size || bytes > 2 * 1024 * 1024 * 1024 {
                return Err("The installer exceeded its verified release size.".to_string());
            }
            digest.update(&chunk);
            output
                .write_all(&chunk)
                .map_err(|error| format!("Unable to save the verified installer: {error}"))?;
        }
        output
            .sync_all()
            .map_err(|error| format!("Unable to finish the verified installer file: {error}"))?;
        if bytes != release.size {
            return Err(format!(
                "The installer download is incomplete: expected {} bytes but received {bytes}.",
                release.size
            ));
        }
        let actual_sha256 = format!("{:x}", digest.finalize());
        if actual_sha256 != release.sha256.to_ascii_lowercase() {
            return Err("The installer SHA-256 does not match trusted release metadata.".to_string());
        }
        fs::rename(&partial_path, &final_path)
            .map_err(|error| format!("Unable to finalize the verified installer: {error}"))?;
        Ok(VerifiedReleaseDownload {
            path: final_path.to_string_lossy().to_string(),
            filename: release.filename.clone(),
            bytes,
            sha256: actual_sha256,
            version: release.version.clone(),
            trust_state: release.trust_state.clone(),
        })
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&partial_path);
    }
    if let Ok(download) = &result {
        append_startup_log_handle(
            &app,
            format!(
                "Verified assisted update downloaded: version={}, file={}, bytes={}, sha256={}, trust={}",
                download.version,
                download.filename,
                download.bytes,
                download.sha256,
                download.trust_state
            ),
        );
    }
    result
}

#[tauri::command]
fn desktop_cancel_update_preparation<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    app.state::<DesktopOperationState>()
        .update_preparing
        .store(false, Ordering::SeqCst);
    append_startup_log_handle(&app, "Update preparation lock released");
}

#[tauri::command]
fn desktop_restart_after_update<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    if !app
        .state::<DesktopOperationState>()
        .update_preparing
        .load(Ordering::SeqCst)
    {
        return Err("A verified update has not been prepared.".to_string());
    }
    append_startup_log_handle(&app, "Verified update installed; restarting Bezgrow");
    orderly_shutdown(&app, "verified update restart");
    app.restart();
}

fn statement_preview(query: &str) -> String {
    query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(180)
        .collect()
}

async fn execute_desktop_statement(
    connection: &mut SqliteConnection,
    statement: &DesktopSqlStatement,
) -> Result<u64, String> {
    let mut query = sqlx::query(&statement.query);
    for value in &statement.bind_values {
        query = match value {
            serde_json::Value::Null => query.bind(Option::<String>::None),
            serde_json::Value::Bool(value) => query.bind(i64::from(*value)),
            serde_json::Value::Number(value) => {
                if let Some(value) = value.as_i64() {
                    query.bind(value)
                } else if let Some(value) = value.as_u64() {
                    let value = i64::try_from(value)
                        .map_err(|_| "SQLite integer bind value is out of range.".to_string())?;
                    query.bind(value)
                } else if let Some(value) = value.as_f64() {
                    query.bind(value)
                } else {
                    return Err("SQLite numeric bind value is invalid.".to_string());
                }
            }
            serde_json::Value::String(value) => query.bind(value),
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                return Err("SQLite transaction bind values must be scalar.".to_string());
            }
        };
    }

    query
        .execute(&mut *connection)
        .await
        .map(|result| result.rows_affected())
        .map_err(|error| error.to_string())
}

fn sqlite_row_value(
    row: &sqlx::sqlite::SqliteRow,
    index: usize,
) -> Result<serde_json::Value, String> {
    let raw = row
        .try_get_raw(index)
        .map_err(|error| format!("Unable to inspect SQLite result column {index}: {error}"))?;
    if raw.is_null() {
        return Ok(serde_json::Value::Null);
    }

    let type_name = raw.type_info().name().to_ascii_uppercase();
    match type_name.as_str() {
        "INTEGER" | "INT" => row
            .try_get::<i64, _>(index)
            .map(serde_json::Value::from)
            .map_err(|error| format!("Unable to decode SQLite integer column {index}: {error}")),
        "REAL" | "FLOAT" | "DOUBLE" | "NUMERIC" => row
            .try_get::<f64, _>(index)
            .map(serde_json::Value::from)
            .map_err(|error| format!("Unable to decode SQLite real column {index}: {error}")),
        "BLOB" => row
            .try_get::<Vec<u8>, _>(index)
            .map(|bytes| {
                serde_json::Value::Array(
                    bytes
                        .into_iter()
                        .map(|byte| serde_json::Value::from(u64::from(byte)))
                        .collect(),
                )
            })
            .map_err(|error| format!("Unable to decode SQLite blob column {index}: {error}")),
        _ => row
            .try_get::<String, _>(index)
            .map(serde_json::Value::from)
            .map_err(|error| format!("Unable to decode SQLite text column {index}: {error}")),
    }
}

async fn select_at_path(
    database_path: &Path,
    statement: &DesktopSqlStatement,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| {
            format!("Unable to open the authoritative desktop SQLite database for a read: {error}")
        })?;

    let mut query = sqlx::query(&statement.query);
    for value in &statement.bind_values {
        query = match value {
            serde_json::Value::Null => query.bind(Option::<String>::None),
            serde_json::Value::Bool(value) => query.bind(i64::from(*value)),
            serde_json::Value::Number(value) => {
                if let Some(value) = value.as_i64() {
                    query.bind(value)
                } else if let Some(value) = value.as_u64() {
                    let value = i64::try_from(value)
                        .map_err(|_| "SQLite integer bind value is out of range.".to_string())?;
                    query.bind(value)
                } else if let Some(value) = value.as_f64() {
                    query.bind(value)
                } else {
                    return Err("SQLite numeric bind value is invalid.".to_string());
                }
            }
            serde_json::Value::String(value) => query.bind(value),
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                return Err("SQLite read bind values must be scalar.".to_string());
            }
        };
    }

    let rows = query.fetch_all(&mut connection).await.map_err(|error| {
        format!(
            "SQLite read failed ({}): {}",
            statement_preview(&statement.query),
            error
        )
    })?;
    rows.into_iter()
        .map(|row| {
            let mut result = serde_json::Map::new();
            for (index, column) in row.columns().iter().enumerate() {
                result.insert(column.name().to_string(), sqlite_row_value(&row, index)?);
            }
            Ok(result)
        })
        .collect()
}

#[tauri::command]
async fn desktop_execute<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    statement: DesktopSqlStatement,
) -> Result<u64, String> {
    let _operation = begin_critical_operation(&app)?;
    let database_path = local_database_path(&app)?;
    let options = SqliteConnectOptions::new()
        .filename(&database_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| {
            format!("Unable to open the authoritative desktop SQLite database for a write: {error}")
        })?;

    match execute_desktop_statement(&mut connection, &statement).await {
        Ok(rows_affected) => Ok(rows_affected),
        Err(error) => {
            let error = format!(
                "SQLite write failed ({}): {}",
                statement_preview(&statement.query),
                error
            );
            append_startup_log_handle(
                &app,
                format!(
                    "SQLite native write failed: {}",
                    error.replace(['\r', '\n'], " ")
                ),
            );
            Err(error)
        }
    }
}

#[tauri::command]
async fn desktop_select<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    statement: DesktopSqlStatement,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let database_path = local_database_path(&app)?;
    match select_at_path(&database_path, &statement).await {
        Ok(rows) => Ok(rows),
        Err(error) => {
            append_startup_log_handle(
                &app,
                format!(
                    "SQLite native read failed: {}",
                    error.replace(['\r', '\n'], " ")
                ),
            );
            Err(error)
        }
    }
}

#[tauri::command]
async fn desktop_execute_transaction<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    statements: Vec<DesktopSqlStatement>,
) -> Result<DesktopTransactionResult, String> {
    let _operation = begin_critical_operation(&app)?;
    let database_path = local_database_path(&app)?;
    match execute_transaction_at_path(&database_path, &statements).await {
        Ok(result) => Ok(result),
        Err(error) => {
            append_startup_log_handle(
                &app,
                format!(
                    "SQLite native transaction failed and was rolled back: {}",
                    error.replace(['\r', '\n'], " ")
                ),
            );
            Err(error)
        }
    }
}

async fn execute_transaction_at_path(
    database_path: &Path,
    statements: &[DesktopSqlStatement],
) -> Result<DesktopTransactionResult, String> {
    if statements.is_empty() {
        return Ok(DesktopTransactionResult {
            statements: 0,
            rows_affected: 0,
        });
    }

    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open the authoritative desktop SQLite database for a transaction: {error}"))?;

    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .map_err(|error| {
            format!("Unable to begin the authoritative desktop SQLite transaction: {error}")
        })?;
    if let Err(error) = sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut connection)
        .await
    {
        let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
        return Err(format!(
            "Unable to defer desktop SQLite foreign-key checks; the transaction was rolled back: {error}"
        ));
    }

    let mut rows_affected = 0_u64;
    for (index, statement) in statements.iter().enumerate() {
        match execute_desktop_statement(&mut connection, statement).await {
            Ok(affected) => rows_affected += affected,
            Err(error)
                if statement.ignore_duplicate_column
                    && error.to_ascii_lowercase().contains("duplicate column name") =>
            {
                continue;
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
                let preview = statement_preview(&statement.query);
                return Err(format!(
                    "SQLite transaction statement {} failed ({}): {}",
                    index + 1,
                    preview,
                    error
                ));
            }
        }
    }

    if let Err(error) = sqlx::query("COMMIT").execute(&mut connection).await {
        let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
        return Err(format!(
            "Unable to commit the authoritative desktop SQLite transaction; all statements were rolled back: {error}"
        ));
    }

    Ok(DesktopTransactionResult {
        statements: statements.len(),
        rows_affected,
    })
}

#[cfg(test)]
mod database_transaction_tests {
    use super::*;

    fn minimal_pdf_bytes(label: &str) -> Vec<u8> {
        let mut bytes = format!(
            "%PDF-1.7\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n2 0 obj\n<< /Length 16 >>\nstream\nBT ({label}) Tj ET\nendstream\nendobj\n"
        )
        .into_bytes();
        bytes.resize(1_600, b' ');
        bytes.extend_from_slice(b"\n%%EOF\n");
        bytes
    }

    fn statement(query: &str, bind_values: Vec<serde_json::Value>) -> DesktopSqlStatement {
        DesktopSqlStatement {
            query: query.to_string(),
            bind_values,
            ignore_duplicate_column: false,
        }
    }

    #[test]
    fn native_batch_commits_and_rolls_back_on_one_connection() {
        let database_path = std::env::temp_dir().join(format!(
            "bezgrow-native-transaction-{}-{}.db",
            std::process::id(),
            unix_timestamp()
        ));

        tauri::async_runtime::block_on(async {
            let options = SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(true);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .expect("create transaction fixture");
            sqlx::query("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
                .execute(&mut connection)
                .await
                .expect("create fixture table");
            sqlx::query(
                "CREATE TABLE references_record (
                    id INTEGER PRIMARY KEY,
                    record_id INTEGER NOT NULL REFERENCES records(id)
                )",
            )
            .execute(&mut connection)
            .await
            .expect("create foreign-key fixture table");
            sqlx::query("INSERT INTO records (id, value) VALUES (10, 'referenced')")
                .execute(&mut connection)
                .await
                .expect("create referenced fixture row");
            sqlx::query("INSERT INTO references_record (id, record_id) VALUES (1, 10)")
                .execute(&mut connection)
                .await
                .expect("create child fixture row");
            connection.close().await.expect("close fixture");

            let committed = execute_transaction_at_path(
                &database_path,
                &[
                    statement(
                        "DELETE FROM records WHERE id = ?",
                        vec![serde_json::json!(10)],
                    ),
                    statement(
                        "INSERT INTO records (id, value) VALUES (?, ?)",
                        vec![serde_json::json!(10), serde_json::json!("reinserted")],
                    ),
                    statement(
                        "INSERT INTO records (id, value) VALUES (?, ?)",
                        vec![serde_json::json!(1), serde_json::json!("first")],
                    ),
                    statement(
                        "INSERT INTO records (id, value) VALUES (?, ?)",
                        vec![serde_json::json!(2), serde_json::json!("second")],
                    ),
                ],
            )
            .await
            .expect("commit native batch");
            assert_eq!(committed.statements, 4);
            assert_eq!(committed.rows_affected, 4);

            let visible_after_commit = select_at_path(
                &database_path,
                &statement(
                    "SELECT value FROM records WHERE id = ?",
                    vec![serde_json::json!(1)],
                ),
            )
            .await
            .expect("read committed native batch through authoritative read path");
            assert_eq!(
                visible_after_commit[0].get("value"),
                Some(&serde_json::json!("first")),
                "a committed mutation must be visible to the next repository read without restart"
            );

            let rolled_back = execute_transaction_at_path(
                &database_path,
                &[
                    statement(
                        "INSERT INTO records (id, value) VALUES (?, ?)",
                        vec![serde_json::json!(3), serde_json::json!("third")],
                    ),
                    statement(
                        "INSERT INTO missing_table (id) VALUES (?)",
                        vec![serde_json::json!(4)],
                    ),
                ],
            )
            .await;
            assert!(rolled_back.is_err());

            let options = SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(false);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .expect("reopen transaction fixture");
            let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM records")
                .fetch_one(&mut connection)
                .await
                .expect("count committed fixture rows");
            assert_eq!(
                count.0, 3,
                "the failed batch must roll back its first statement"
            );
            connection.close().await.expect("close transaction fixture");
        });

        let _ = fs::remove_file(database_path);
    }

    #[test]
    fn windows_legacy_data_migration_never_overwrites_current_files() {
        let fixture_root = std::env::temp_dir().join(format!(
            "bezgrow-data-migration-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        let legacy = fixture_root.join("legacy");
        let managed = fixture_root.join("managed");
        fs::create_dir_all(&legacy).expect("create legacy fixture");
        fs::create_dir_all(&managed).expect("create managed fixture");
        fs::write(legacy.join("logo.png"), b"legacy").expect("write legacy fixture");
        fs::write(legacy.join("backup.db"), b"backup").expect("write legacy backup");
        fs::write(legacy.join(LOCAL_DATABASE_NAME), b"sqlite-main")
            .expect("write legacy SQLite fixture");
        fs::write(
            legacy.join(format!("{LOCAL_DATABASE_NAME}-wal")),
            b"sqlite-wal",
        )
        .expect("write legacy SQLite WAL fixture");
        fs::write(managed.join("logo.png"), b"current").expect("write current fixture");

        assert_eq!(
            copy_directory_missing_without_sqlite(&legacy, &managed)
                .expect("migrate only missing non-SQLite files"),
            1
        );
        assert_eq!(
            copy_directory_missing_without_sqlite(&legacy, &managed)
                .expect("repeat idempotent migration"),
            0,
            "a repeated upgrade must not copy or duplicate files"
        );

        assert_eq!(
            fs::read(managed.join("logo.png")).expect("read current fixture"),
            b"current",
            "an upgrade must never replace current managed data with a legacy copy"
        );
        assert_eq!(
            fs::read(managed.join("backup.db")).expect("read migrated backup"),
            b"backup"
        );
        assert!(
            !managed.join(LOCAL_DATABASE_NAME).exists()
                && !managed.join(format!("{LOCAL_DATABASE_NAME}-wal")).exists(),
            "generic directory recovery must never activate SQLite or its sidecars"
        );
        let _ = fs::remove_dir_all(fixture_root);
    }

    #[test]
    fn legacy_sqlite_migration_is_verified_atomic_and_idempotent() {
        let fixture_root = std::env::temp_dir().join(format!(
            "bezgrow-sqlite-upgrade-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        fs::create_dir_all(&fixture_root).expect("create SQLite upgrade fixture");
        let legacy = fixture_root.join("legacy.db");
        let canonical = fixture_root.join("canonical").join(LOCAL_DATABASE_NAME);

        tauri::async_runtime::block_on(async {
            let options = SqliteConnectOptions::new()
                .filename(&legacy)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .expect("create legacy Bezgrow database");
            sqlx::query("PRAGMA wal_autocheckpoint = 0")
                .execute(&mut connection)
                .await
                .expect("retain the legacy WAL fixture");
            for statement in [
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)",
                "CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
                "CREATE TABLE license_state (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, license_key TEXT NOT NULL)",
                "CREATE TABLE products (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL)",
                "INSERT INTO schema_migrations VALUES (17, 'upgrade-fixture')",
                "INSERT INTO organizations VALUES ('business-a', 'Preserved Business')",
                "INSERT INTO license_state VALUES ('license-a', 'business-a', 'signed-license-fixture')",
                "INSERT INTO products VALUES ('product-a', 'business-a', 'Preserved Product')",
            ] {
                sqlx::query(statement)
                    .execute(&mut connection)
                    .await
                    .expect("build recognized legacy schema");
            }
            assert!(migrate_legacy_database_missing(&legacy, &canonical)
                .await
                .expect("migrate verified legacy database"));
            connection.close().await.expect("close legacy database");
            assert!(!migrate_legacy_database_missing(&legacy, &canonical)
                .await
                .expect("repeat legacy migration"));
            assert!(
                !sqlite_sidecar_path(&canonical, "-wal").exists(),
                "the activated snapshot must be a single atomic SQLite file"
            );

            let options = SqliteConnectOptions::new()
                .filename(&canonical)
                .create_if_missing(false)
                .read_only(true);
            let mut migrated = SqliteConnection::connect_with(&options)
                .await
                .expect("open migrated database");
            let product_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM products WHERE id = 'product-a'")
                    .fetch_one(&mut migrated)
                    .await
                    .expect("count migrated product");
            let license_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM license_state WHERE id = 'license-a'")
                    .fetch_one(&mut migrated)
                    .await
                    .expect("count migrated licence");
            assert_eq!(product_count, 1);
            assert_eq!(license_count, 1);
            migrated.close().await.expect("close migrated database");
        });

        let _ = fs::remove_dir_all(fixture_root);
    }

    #[test]
    fn unrelated_sqlite_is_rejected_as_a_legacy_bezgrow_database() {
        let fixture_root = std::env::temp_dir().join(format!(
            "bezgrow-unrelated-sqlite-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        fs::create_dir_all(&fixture_root).expect("create unrelated SQLite fixture");
        let unrelated = fixture_root.join("unrelated.db");
        let canonical = fixture_root.join("canonical.db");
        tauri::async_runtime::block_on(async {
            let options = SqliteConnectOptions::new()
                .filename(&unrelated)
                .create_if_missing(true);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .expect("create unrelated database");
            sqlx::query("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)")
                .execute(&mut connection)
                .await
                .expect("create unrelated table");
            connection.close().await.expect("close unrelated database");
            assert!(migrate_legacy_database_missing(&unrelated, &canonical)
                .await
                .is_err());
            assert!(!canonical.exists());
        });
        let _ = fs::remove_dir_all(fixture_root);
    }

    #[test]
    fn installation_device_id_is_migrated_and_stays_stable() {
        let fixture_root = std::env::temp_dir().join(format!(
            "bezgrow-device-identity-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        let migrated = "BZG-54842A525D2A47A5BEB2CBD7";
        let first = get_or_create_device_id_at(&fixture_root, Some(migrated))
            .expect("migrate the previous device identity");
        assert_eq!(first, migrated);
        let second =
            get_or_create_device_id_at(&fixture_root, Some("BZG-AAAAAAAAAAAAAAAAAAAAAAAA"))
                .expect("reuse the persisted device identity");
        assert_eq!(
            second, migrated,
            "a later candidate must never replace the installation identity"
        );

        let generated_root = fixture_root.join("fresh-installation");
        let generated = get_or_create_device_id_at(&generated_root, None)
            .expect("create a deterministic identity from the installation seed");
        fs::remove_file(generated_root.join(DEVICE_ID_FILENAME))
            .expect("remove only the derived fixture identity");
        let regenerated = get_or_create_device_id_at(&generated_root, None)
            .expect("derive the same identity from the persisted installation seed");
        assert_eq!(generated, regenerated);

        let _ = fs::remove_dir_all(fixture_root);
    }

    #[test]
    fn invoice_share_file_is_reused_without_duplicates() {
        let fixture_root = std::env::temp_dir().join(format!(
            "bezgrow-invoice-share-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        let first_bytes = minimal_pdf_bytes("E2E first");
        let second_bytes = minimal_pdf_bytes("E2E replacement");
        let first = prepare_invoice_share_at(&fixture_root, "E2E-Invoice-00005.pdf", &first_bytes)
            .expect("prepare the first local invoice PDF");
        let second =
            prepare_invoice_share_at(&fixture_root, "E2E-Invoice-00005.pdf", &second_bytes)
                .expect("reuse the predictable invoice PDF path");
        assert_eq!(first.path, second.path);
        assert_eq!(
            fs::read(&second.path).expect("read the reusable invoice PDF"),
            second_bytes
        );
        assert_eq!(
            fs::read_dir(&fixture_root)
                .expect("read invoice share fixture")
                .filter_map(Result::ok)
                .filter(
                    |entry| entry.path().extension().and_then(|value| value.to_str())
                        == Some("pdf")
                )
                .count(),
            1,
            "a repeated share attempt must not create another PDF"
        );
        assert!(prepare_invoice_share_at(&fixture_root, "invalid.pdf", b"not-a-pdf").is_err());
        assert!(!fixture_root.join(".E2E-Invoice-00005.pdf.tmp").exists());
        let _ = fs::remove_dir_all(fixture_root);
    }

    #[test]
    fn native_backup_snapshot_and_restore_preserve_authoritative_data() {
        let fixture_root = std::env::temp_dir().join(format!(
            "bezgrow-backup-restore-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        fs::create_dir_all(&fixture_root).expect("create backup fixture directory");
        let database_path = fixture_root.join("current.db");
        let snapshot_path = fixture_root.join("snapshot.db");

        tauri::async_runtime::block_on(async {
            let options = SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(true);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .expect("create backup fixture");
            for statement in [
                "CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, deleted_at TEXT)",
                "CREATE TABLE financial_years (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), start_date TEXT NOT NULL, end_date TEXT NOT NULL)",
                "CREATE TABLE chart_of_accounts (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), account_name TEXT NOT NULL)",
                "CREATE TABLE accounting_vouchers (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), financial_year_id TEXT NOT NULL REFERENCES financial_years(id), voucher_date TEXT NOT NULL, source_type TEXT, source_id TEXT, status TEXT NOT NULL, total_debit_minor INTEGER NOT NULL, total_credit_minor INTEGER NOT NULL)",
                "CREATE TABLE accounting_voucher_entries (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), voucher_id TEXT NOT NULL REFERENCES accounting_vouchers(id), account_id TEXT NOT NULL REFERENCES chart_of_accounts(id), debit_minor INTEGER NOT NULL, credit_minor INTEGER NOT NULL)",
                "CREATE TABLE products (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, stock REAL NOT NULL)",
                "CREATE TABLE customers (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL)",
                "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), customer_id TEXT NOT NULL REFERENCES customers(id), invoice_number TEXT NOT NULL, total REAL NOT NULL)",
                "CREATE TABLE sales_invoice_items (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), invoice_id TEXT NOT NULL REFERENCES sales_invoices(id), product_id TEXT NOT NULL REFERENCES products(id), quantity REAL NOT NULL)",
                "CREATE TABLE license_state (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), signed_license_key TEXT NOT NULL)",
                "CREATE TABLE device_activations (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), device_id TEXT NOT NULL)",
                "INSERT INTO organizations VALUES ('org-a', 'Backed-up Business', NULL)",
                "INSERT INTO financial_years VALUES ('fy-a', 'org-a', '2026-04-01', '2027-03-31')",
                "INSERT INTO chart_of_accounts VALUES ('cash-a', 'org-a', 'Cash')",
                "INSERT INTO chart_of_accounts VALUES ('capital-a', 'org-a', 'Capital')",
                "INSERT INTO accounting_vouchers VALUES ('opening-a', 'org-a', 'fy-a', '2026-04-01', 'ACCOUNTING_ACTIVATION', 'org-a', 'posted', 12500, 12500)",
                "INSERT INTO accounting_voucher_entries VALUES ('opening-line-1', 'org-a', 'opening-a', 'cash-a', 12500, 0)",
                "INSERT INTO accounting_voucher_entries VALUES ('opening-line-2', 'org-a', 'opening-a', 'capital-a', 0, 12500)",
                "INSERT INTO products VALUES ('product-a', 'org-a', 'Backed-up Product', 12)",
                "INSERT INTO customers VALUES ('customer-a', 'org-a', 'Backed-up Customer')",
                "INSERT INTO sales_invoices VALUES ('invoice-a', 'org-a', 'customer-a', 'INV-00001', 750)",
                "INSERT INTO sales_invoice_items VALUES ('item-a', 'org-a', 'invoice-a', 'product-a', 2)",
                "INSERT INTO license_state VALUES ('license-a', 'org-a', 'backup-license')",
                "INSERT INTO device_activations VALUES ('device-a', 'org-a', 'backup-device')",
                "PRAGMA user_version = 11",
            ] {
                sqlx::query(statement)
                    .execute(&mut connection)
                    .await
                    .expect("prepare representative backup fixture");
            }
            connection.close().await.expect("close backup fixture");

            create_consistent_database_snapshot(&database_path, &snapshot_path)
                .await
                .expect("create consistent SQLite snapshot");
            assert_eq!(
                verify_backup_database(&snapshot_path, "org-a")
                    .await
                    .expect("verify representative backup"),
                11
            );

            let options = SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(false);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .expect("open active fixture for mutation");
            for statement in [
                "UPDATE products SET name = 'Changed Product', stock = 1 WHERE id = 'product-a'",
                "DELETE FROM sales_invoice_items WHERE invoice_id = 'invoice-a'",
                "DELETE FROM sales_invoices WHERE id = 'invoice-a'",
                "DELETE FROM accounting_voucher_entries WHERE voucher_id = 'opening-a'",
                "DELETE FROM accounting_vouchers WHERE id = 'opening-a'",
                "UPDATE license_state SET signed_license_key = 'current-installation-license' WHERE id = 'license-a'",
                "UPDATE device_activations SET device_id = 'current-installation-device' WHERE id = 'device-a'",
            ] {
                sqlx::query(statement)
                    .execute(&mut connection)
                    .await
                    .expect("mutate active fixture after backup");
            }
            connection.close().await.expect("close mutated fixture");

            restore_database_contents(&database_path, &snapshot_path)
                .await
                .expect("restore the verified SQLite snapshot");

            let options = SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(false);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .expect("reopen restored fixture");
            let restored: (String, f64) =
                sqlx::query_as("SELECT name, stock FROM products WHERE id = 'product-a'")
                    .fetch_one(&mut connection)
                    .await
                    .expect("read restored row");
            assert_eq!(restored, ("Backed-up Product".to_string(), 12.0));
            let relationship_count: (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM sales_invoice_items item JOIN sales_invoices invoice ON invoice.id = item.invoice_id JOIN customers customer ON customer.id = invoice.customer_id WHERE item.id = 'item-a' AND customer.name = 'Backed-up Customer'",
            )
            .fetch_one(&mut connection)
            .await
            .expect("verify restored invoice relationships");
            assert_eq!(relationship_count.0, 1);
            let accounting_count: (i64, i64) = sqlx::query_as(
                "SELECT (SELECT COUNT(*) FROM accounting_vouchers WHERE id = 'opening-a'), (SELECT COUNT(*) FROM accounting_voucher_entries WHERE voucher_id = 'opening-a')",
            )
            .fetch_one(&mut connection)
            .await
            .expect("verify restored accounting journal");
            assert_eq!(accounting_count, (1, 2));
            verify_accounting_integrity(&mut connection, "restored test database")
                .await
                .expect("verify restored accounting integrity");
            let installation_state: (String, String) = sqlx::query_as(
                "SELECT license_state.signed_license_key, device_activations.device_id FROM license_state CROSS JOIN device_activations",
            )
            .fetch_one(&mut connection)
            .await
            .expect("read preserved installation state");
            assert_eq!(installation_state.0, "current-installation-license");
            assert_eq!(installation_state.1, "current-installation-device");
            let integrity: (String,) = sqlx::query_as("PRAGMA quick_check")
                .fetch_one(&mut connection)
                .await
                .expect("check restored database integrity");
            assert_eq!(integrity.0.to_ascii_lowercase(), "ok");
            connection.close().await.expect("close restored fixture");
        });

        let _ = fs::remove_dir_all(fixture_root);
    }

    #[test]
    fn corrupted_backup_database_is_rejected_before_restore() {
        let fixture_root = std::env::temp_dir().join(format!(
            "bezgrow-corrupt-backup-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        fs::create_dir_all(&fixture_root).expect("create corrupt backup fixture");
        let corrupt_path = fixture_root.join("database.sqlite");
        fs::write(&corrupt_path, b"this is not sqlite").expect("write corrupt backup fixture");
        tauri::async_runtime::block_on(async {
            assert!(verify_backup_database(&corrupt_path, "org-a")
                .await
                .is_err());
        });
        let _ = fs::remove_dir_all(fixture_root);
    }
}

#[tauri::command]
fn store_secret(key: String, value: String) -> Result<(), String> {
    keychain_entry(&key)?
        .set_password(&value)
        .map_err(|error| error.to_string())?;
    // Re-open the entry: a successful write on an ephemeral/mock handle is
    // not proof of persistence. Never include credential contents in errors.
    let persisted = keychain_entry(&key)?
        .get_password()
        .map_err(|_| "The secure credential could not be read after saving.".to_string())?;
    if persisted != value {
        return Err("The secure credential could not be verified after saving.".to_string());
    }
    Ok(())
}

#[tauri::command]
fn read_secret(key: String) -> Result<Option<String>, String> {
    match keychain_entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn delete_secret(key: String) -> Result<(), String> {
    match keychain_entry(&key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn validate_external_url(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|error| format!("Invalid URL: {error}"))?;

    if matches!(parsed.scheme(), "https" | "mailto") {
        return Ok(());
    }

    if cfg!(debug_assertions) && parsed.scheme() == "http" {
        let host = parsed.host_str().unwrap_or_default();
        if matches!(host, "127.0.0.1" | "localhost") {
            return Ok(());
        }
    }

    Err("Only trusted web URLs can be opened externally.".to_string())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url)?;

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|error| format!("Unable to open browser: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        windows_hidden_command("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(&url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Unable to open browser: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|error| format!("Unable to open browser: {error}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Opening external browser is not supported on this platform.".to_string())
    }
}

fn validate_platform_admin_url(url: &str) -> Result<tauri::Url, String> {
    let mut parsed =
        tauri::Url::parse(url).map_err(|error| format!("Invalid Platform Admin URL: {error}"))?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if parsed.scheme() == "http" && matches!(host.as_str(), "127.0.0.1" | "localhost") {
        parsed.set_path("/login");
        parsed.set_query(Some(
            "next=%2Fadmin%3Fdesktop%3D1&platform_admin=1&desktop=1",
        ));
        parsed.set_fragment(None);
        return Ok(parsed);
    }

    Err(
        "Platform Administration must run inside the local Bezgrow desktop application."
            .to_string(),
    )
}

#[tauri::command]
fn open_platform_admin<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "The Bezgrow desktop window is unavailable.".to_string())?;
    let main_url = main_window
        .url()
        .map_err(|error| format!("Unable to read the Bezgrow desktop URL: {error}"))?;
    let parsed = validate_platform_admin_url(main_url.as_str())?;

    if let Some(window) = app.get_webview_window("platform-admin") {
        window
            .set_focus()
            .map_err(|error| format!("Unable to focus Platform Administration: {error}"))?;
        return Ok(());
    }

    let builder =
        tauri::WebviewWindowBuilder::new(&app, "platform-admin", WebviewUrl::External(parsed))
            .title("Bezgrow Platform Administration — Internet Required")
            .inner_size(1440.0, 900.0)
            .min_inner_size(1080.0, 700.0)
            .resizable(true)
            .fullscreen(false)
            .initialization_script(
                "window.__BEZGROW_DESKTOP__ = true; window.__BEZGROW_PLATFORM_ADMIN_WINDOW__ = true; window.isTauri = true;",
            );

    #[cfg(target_os = "windows")]
    let builder = builder.data_directory(managed_data_directory(&app, "WebView")?);

    builder
        .build()
        .map_err(|error| format!("Unable to open Platform Administration: {error}"))?;

    append_startup_log_handle(
        &app,
        "Device-bound Platform Administration window opened inside Bezgrow",
    );
    Ok(())
}

#[tauri::command]
fn desktop_reveal_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.is_file() {
        return Err("The saved file could not be found.".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map_err(|error| format!("Unable to show the saved file: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        windows_hidden_command("explorer.exe")
            .arg(format!("/select,{}", target.to_string_lossy()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Unable to show the saved file: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let parent = target
            .parent()
            .ok_or_else(|| "The saved file folder could not be found.".to_string())?;
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|error| format!("Unable to show the saved file: {error}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Showing a saved file is not supported on this platform.".to_string())
    }
}

#[tauri::command]
fn desktop_open_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.is_file() {
        return Err("The saved file could not be found.".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|error| format!("Unable to open the saved file: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        windows_hidden_command("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(&target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Unable to open the saved file: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|error| format!("Unable to open the saved file: {error}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Opening saved files is not supported on this platform.".to_string())
    }
}

#[cfg(any(test, not(debug_assertions)))]
fn decode_chunked_http_body(mut body: &[u8]) -> Option<Vec<u8>> {
    let mut decoded = Vec::new();
    loop {
        let line_end = body.windows(2).position(|window| window == b"\r\n")?;
        let size_text = std::str::from_utf8(&body[..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Some(decoded);
        }
        if body.len() < size + 2 || &body[size..size + 2] != b"\r\n" {
            return None;
        }
        decoded.extend_from_slice(&body[..size]);
        body = &body[size + 2..];
        if decoded.len() > 16 * 1024 {
            return None;
        }
    }
}

#[cfg(test)]
mod runtime_lifecycle_tests {
    use super::{
        current_release_architecture, current_release_platform, decode_chunked_http_body,
        validate_verified_release_request, VerifiedReleaseDownloadRequest,
    };

    fn valid_release_request() -> VerifiedReleaseDownloadRequest {
        let platform = current_release_platform();
        let platform_query = if platform == "windows" {
            "windows"
        } else {
            "mac"
        };
        let extension = if platform == "windows" { "exe" } else { "dmg" };
        VerifiedReleaseDownloadRequest {
            url: format!("https://www.bezgrow.com/api/downloads/desktop?platform={platform_query}"),
            version: "0.1.15".to_string(),
            platform: platform.to_string(),
            architecture: current_release_architecture().to_string(),
            filename: format!(
                "Bezgrow-0.1.15-{}.{}",
                current_release_architecture(),
                extension
            ),
            size: 80 * 1024 * 1024,
            sha256: "a".repeat(64),
            trust_state: "unsigned-manual-install".to_string(),
        }
    }

    #[test]
    fn authenticated_health_chunked_body_is_decoded() {
        let encoded = b"a\r\n{\"status\":\r\n5\r\n\"ok\"}\r\n0\r\n\r\n";
        assert_eq!(
            decode_chunked_http_body(encoded).as_deref(),
            Some(b"{\"status\":\"ok\"}".as_slice())
        );
    }

    #[test]
    fn malformed_health_chunk_is_rejected() {
        assert!(decode_chunked_http_body(b"20\r\nshort\r\n0\r\n\r\n").is_none());
    }

    #[test]
    fn assisted_update_accepts_only_the_verified_bezgrow_endpoint() {
        if current_release_platform() == "unsupported" {
            return;
        }
        let mut release = valid_release_request();
        assert!(validate_verified_release_request(&release).is_ok());
        release.url = "https://example.com/api/downloads/desktop?platform=mac".to_string();
        assert!(validate_verified_release_request(&release)
            .unwrap_err()
            .contains("trusted Bezgrow release endpoint"));
    }

    #[test]
    fn assisted_update_rejects_wrong_architecture_and_invalid_trust() {
        if current_release_platform() == "unsupported" {
            return;
        }
        let mut release = valid_release_request();
        release.architecture = if current_release_architecture() == "arm64" {
            "x64".to_string()
        } else {
            "arm64".to_string()
        };
        assert!(validate_verified_release_request(&release)
            .unwrap_err()
            .contains("architecture"));

        let mut release = valid_release_request();
        release.trust_state = "invalid".to_string();
        assert!(validate_verified_release_request(&release)
            .unwrap_err()
            .contains("trust state"));
    }
}

#[cfg(not(debug_assertions))]
fn request_runtime_health(port: u16, token: Option<&str>) -> Option<RuntimeHealth> {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return None;
    };
    let timeout = Some(Duration::from_millis(350));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    let authentication = token
        .map(|value| format!("{RUNTIME_HEALTH_HEADER}: {value}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "GET {RUNTIME_HEALTH_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{authentication}Connection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return None;
    }

    let mut response = Vec::with_capacity(2048);
    if stream.take(16 * 1024).read_to_end(&mut response).is_err() {
        return None;
    }
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?;
    let headers = String::from_utf8_lossy(&response[..header_end]);
    if !headers.starts_with("HTTP/1.1 200") {
        return None;
    }
    let body = &response[header_end + 4..];
    let decoded;
    let body = if headers
        .lines()
        .any(|line| line.eq_ignore_ascii_case("transfer-encoding: chunked"))
    {
        decoded = decode_chunked_http_body(body)?;
        decoded.as_slice()
    } else {
        body
    };
    serde_json::from_slice(body).ok()
}

#[cfg(not(debug_assertions))]
fn local_runtime_responds(ownership: &RuntimeOwnership) -> bool {
    let Some(health) = request_runtime_health(ownership.port, Some(&ownership.token)) else {
        return false;
    };
    health.status == "ok"
        && health.runtime == "bezgrow-embedded"
        && health.app_version.as_deref() == Some(ownership.app_version.as_str())
        && health.shell_pid == Some(ownership.shell_pid)
        && health.server_pid == Some(ownership.server_pid)
}

#[cfg(not(debug_assertions))]
fn legacy_runtime_responds(port: u16) -> bool {
    request_runtime_health(port, None)
        .map(|health| health.status == "ok" && health.runtime == "bezgrow-embedded")
        .unwrap_or(false)
}

#[cfg(not(debug_assertions))]
fn wait_for_local_server(child: &mut Child, ownership: &RuntimeOwnership) -> Result<(), String> {
    for _ in 0..160 {
        if local_runtime_responds(ownership) {
            return Ok(());
        }

        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Unable to inspect bundled server process: {error}"))?
        {
            return Err(format!(
                "Bundled Bezgrow server exited before it was ready with status {status}"
            ));
        }

        thread::sleep(Duration::from_millis(100));
    }

    Err(
        "Bundled Bezgrow server did not return its authenticated runtime identity in time"
            .to_string(),
    )
}

#[cfg(not(debug_assertions))]
fn terminate_verified_runtime_pid(pid: u32, process_group: Option<u32>) -> bool {
    #[cfg(target_os = "windows")]
    {
        let _ = windows_hidden_command("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(target_os = "macos")]
    unsafe {
        let signal_target = match process_group {
            Some(group) if group == pid && libc::getpgid(pid as i32) == group as i32 => {
                -(group as i32)
            }
            _ => pid as i32,
        };
        libc::kill(signal_target, libc::SIGTERM);
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_millis(1500) {
        let group_exited = {
            #[cfg(target_os = "macos")]
            {
                process_group
                    .map(|group| !process_group_exists(group))
                    .unwrap_or(true)
            }
            #[cfg(not(target_os = "macos"))]
            {
                true
            }
        };
        if process_executable_path(pid).is_none() && group_exited {
            return true;
        }
        thread::sleep(Duration::from_millis(40));
    }

    #[cfg(target_os = "macos")]
    unsafe {
        let signal_target = match process_group {
            Some(group) if group == pid && libc::getpgid(pid as i32) == group as i32 => {
                -(group as i32)
            }
            _ => pid as i32,
        };
        libc::kill(signal_target, libc::SIGKILL);
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
    }

    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_millis(800) {
        let group_exited = {
            #[cfg(target_os = "macos")]
            {
                process_group
                    .map(|group| !process_group_exists(group))
                    .unwrap_or(true)
            }
            #[cfg(not(target_os = "macos"))]
            {
                true
            }
        };
        if process_executable_path(pid).is_none() && group_exited {
            return true;
        }
        thread::sleep(Duration::from_millis(40));
    }
    process_executable_path(pid).is_none() && {
        #[cfg(target_os = "macos")]
        {
            process_group
                .map(|group| !process_group_exists(group))
                .unwrap_or(true)
        }
        #[cfg(not(target_os = "macos"))]
        {
            true
        }
    }
}

#[cfg(not(debug_assertions))]
fn recover_recorded_runtime<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let ownership = match read_runtime_state(app) {
        Ok(Some(ownership)) => ownership,
        Ok(None) => return Ok(()),
        Err(error) => {
            append_startup_log_handle(
                app,
                format!("Discarding invalid transient runtime metadata: {error}"),
            );
            remove_runtime_state(app);
            return Ok(());
        }
    };

    let authenticated = local_runtime_responds(&ownership);
    if !runtime_process_identity_matches(&ownership) && !authenticated {
        append_startup_log_handle(
            app,
            format!(
                "Runtime metadata did not match a live Bezgrow child; no process was terminated. recorded_shell_pid={}, recorded_server_pid={}, recorded_port={}",
                ownership.shell_pid, ownership.server_pid, ownership.port
            ),
        );
        remove_runtime_state(app);
        return Ok(());
    }

    let parent_is_alive =
        process_matches_recorded_path(ownership.shell_pid, &ownership.shell_executable)
            || (authenticated
                && process_executable_path(ownership.shell_pid)
                    .map(|path| looks_like_bezgrow_shell(&path))
                    .unwrap_or(false));
    if parent_is_alive && ownership.shell_pid != std::process::id() {
        return Err(format!(
            "Another active Bezgrow shell (PID {}) owns the authenticated local runtime. The single-instance handoff could not be completed.",
            ownership.shell_pid
        ));
    }

    append_startup_log_handle(
        app,
        format!(
            "Recovering verified stale Bezgrow runtime. recorded_shell_pid={}, server_pid={}, port={}, recorded_version={}, current_version={}, authenticated={authenticated}",
            ownership.shell_pid,
            ownership.server_pid,
            ownership.port,
            ownership.app_version,
            app.package_info().version
        ),
    );
    if !terminate_verified_runtime_pid(ownership.server_pid, ownership.server_process_group) {
        return Err(format!(
            "A verified stale Bezgrow runtime (PID {}) could not be stopped safely.",
            ownership.server_pid
        ));
    }
    if !wait_for_port_release(ownership.port, Duration::from_secs(2)) {
        return Err(format!(
            "The verified stale Bezgrow runtime exited, but port {} was not released.",
            ownership.port
        ));
    }
    remove_runtime_state_if_owned(app, &ownership);
    append_startup_log_handle(
        app,
        format!(
            "Verified stale Bezgrow runtime recovery completed. server_pid={}, released_port={}",
            ownership.server_pid, ownership.port
        ),
    );
    Ok(())
}

#[cfg(all(not(debug_assertions), target_os = "macos"))]
fn legacy_runtime_identity_matches(pid: u32) -> bool {
    if process_parent_pid(pid) != Some(1) {
        return false;
    }
    let Some(executable) = process_executable_path(pid) else {
        return false;
    };
    let Some(current_directory) = process_current_directory(pid) else {
        return false;
    };
    let server_entry = current_directory.join("server.js");
    let same_resources_root = executable
        .parent()
        .and_then(Path::parent)
        .zip(current_directory.parent())
        .map(|(executable_resources, server_resources)| executable_resources == server_resources)
        .unwrap_or(false);
    same_resources_root
        && looks_like_bundled_node(&executable, &server_entry)
        && process_listening_ports(pid)
            .into_iter()
            .any(legacy_runtime_responds)
}

#[cfg(all(not(debug_assertions), not(target_os = "macos")))]
fn legacy_runtime_identity_matches(_pid: u32) -> bool {
    false
}

#[cfg(not(debug_assertions))]
fn recover_legacy_orphaned_runtimes<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let marker = match create_runtime_directory(app) {
        Ok(directory) => directory.join(LEGACY_CLEANUP_MARKER_FILENAME),
        Err(error) => {
            append_startup_log_handle(
                app,
                format!("Legacy runtime recovery could not prepare its marker: {error}"),
            );
            return;
        }
    };
    if marker.is_file() {
        return;
    }
    let started = std::time::Instant::now();
    #[cfg(target_os = "macos")]
    let candidates = all_process_ids();
    #[cfg(not(target_os = "macos"))]
    let candidates = listening_process_ids(DESKTOP_SERVER_PORT);
    let verified = candidates
        .into_iter()
        .filter(|pid| legacy_runtime_identity_matches(*pid))
        .collect::<Vec<_>>();
    let recovered_count = verified.len();
    for pid in verified {
        let ports = {
            #[cfg(target_os = "macos")]
            {
                process_listening_ports(pid)
            }
            #[cfg(not(target_os = "macos"))]
            {
                vec![DESKTOP_SERVER_PORT]
            }
        };
        append_startup_log_handle(
            app,
            format!(
                "Recovering verified legacy Bezgrow runtime without ownership metadata. server_pid={pid}, ports={ports:?}"
            ),
        );
        if terminate_verified_runtime_pid(pid, None)
            && ports
                .iter()
                .all(|port| wait_for_port_release(*port, Duration::from_secs(2)))
        {
            append_startup_log_handle(
                app,
                format!(
                    "Verified legacy Bezgrow runtime recovery completed. server_pid={pid}, released_ports={ports:?}"
                ),
            );
        } else {
            append_startup_log_handle(
                app,
                format!(
                    "Verified legacy Bezgrow runtime did not stop cleanly. server_pid={pid}, ports={ports:?}"
                ),
            );
        }
    }
    if let Err(error) = fs::write(&marker, format!("{}\n", unix_timestamp())) {
        append_startup_log_handle(
            app,
            format!("Legacy runtime recovery marker could not be persisted: {error}"),
        );
    }
    append_startup_log_handle(
        app,
        format!(
            "Legacy runtime migration scan completed. recovered_processes={recovered_count}, duration_ms={}",
            started.elapsed().as_millis()
        ),
    );
}

#[cfg(not(debug_assertions))]
fn select_local_port<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<u16, String> {
    if port_is_available(DESKTOP_SERVER_PORT) {
        return Ok(DESKTOP_SERVER_PORT);
    }

    let owners = listening_process_ids(DESKTOP_SERVER_PORT);
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        format!(
            "Bezgrow could not reserve an authenticated fallback port while {DESKTOP_SERVER_PORT} was occupied: {error}"
        )
    })?;
    let fallback = listener
        .local_addr()
        .map_err(|error| format!("Bezgrow could not inspect its fallback port: {error}"))?
        .port();
    drop(listener);
    append_startup_log_handle(
        app,
        format!(
            "Preferred port {DESKTOP_SERVER_PORT} belongs to an unrelated or unverifiable process; leaving it untouched and selecting authenticated fallback port {fallback}. listener_pids={owners:?}"
        ),
    );
    Ok(fallback)
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn external_process_path(path: PathBuf) -> PathBuf {
    let path_text = path.to_string_lossy();
    if let Some(network_path) = path_text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{network_path}"));
    }
    if let Some(standard_path) = path_text.strip_prefix(r"\\?\") {
        return PathBuf::from(standard_path);
    }
    path
}

#[cfg(all(not(debug_assertions), not(target_os = "windows")))]
fn external_process_path(path: PathBuf) -> PathBuf {
    path
}

#[cfg(not(debug_assertions))]
fn bundled_node_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let executable_name = if cfg!(windows) { "node.exe" } else { "node" };
    let node_path = app
        .path()
        .resource_dir()?
        .join("node")
        .join(executable_name);

    if !node_path.exists() {
        return Err(format!(
            "Bundled Node runtime was not found at {}",
            node_path.display()
        )
        .into());
    }

    Ok(node_path)
}

#[cfg(debug_assertions)]
fn start_next_server<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<u16, Box<dyn std::error::Error>> {
    append_startup_log(app, "Using Next.js dev server at http://localhost:3000");
    Ok(3000)
}

#[cfg(not(debug_assertions))]
fn start_next_server<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<u16, Box<dyn std::error::Error>> {
    recover_recorded_runtime(app)?;
    recover_legacy_orphaned_runtimes(app);
    let port = select_local_port(app)?;
    let resource_dir = external_process_path(app.path().resource_dir()?);
    let server_dir = resource_dir.join("next-server");
    let server_entry = server_dir.join("server.js");
    let node_path = external_process_path(bundled_node_path(app)?);
    let log_path = startup_log_path(app);
    let temporary_directory = managed_data_directory(app, "Temporary")?;
    let token = generate_runtime_token()?;
    let shell_pid = std::process::id();
    let shell_executable = std::env::current_exe()?;
    let app_version = app.package_info().version.to_string();
    let started = std::time::Instant::now();

    append_startup_log(
        app,
        format!(
            "Starting bundled Next server. shell_pid={shell_pid}, version={app_version}, resources={}, node={}, server={}, port={port}",
            resource_dir.display(),
            node_path.display(),
            server_entry.display()
        ),
    );

    if !server_entry.exists() {
        return Err(format!(
            "Bundled Next server was not found at {}",
            server_entry.display()
        )
        .into());
    }

    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;

    let mut command = Command::new(&node_path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(target_os = "macos")]
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = command
        .arg(&server_entry)
        .current_dir(&server_dir)
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        .env("BEZGROW_DESKTOP_BUILD", "1")
        .env("BEZGROW_RUNTIME_TOKEN", &token)
        .env("BEZGROW_RUNTIME_VERSION", &app_version)
        .env("BEZGROW_RUNTIME_BUILD_COMMIT", NATIVE_BUILD_COMMIT)
        .env("BEZGROW_RUNTIME_BUILD_TIMESTAMP", NATIVE_BUILD_TIMESTAMP)
        .env("BEZGROW_RUNTIME_SHELL_PID", shell_pid.to_string())
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("TEMP", &temporary_directory)
        .env("TMP", &temporary_directory)
        .env("TMPDIR", &temporary_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file.try_clone()?))
        .stderr(Stdio::from(log_file))
        .spawn()
        .map_err(|error| {
            format!(
                "Unable to start bundled Bezgrow server with {}: {error}",
                node_path.display()
            )
        })?;

    let server_pid = child.id();
    let ownership = RuntimeOwnership {
        schema_version: RUNTIME_STATE_SCHEMA,
        shell_pid,
        shell_executable: shell_executable.to_string_lossy().to_string(),
        server_pid,
        server_process_group: if cfg!(target_os = "macos") {
            Some(server_pid)
        } else {
            None
        },
        server_executable: node_path.to_string_lossy().to_string(),
        server_entry: server_entry.to_string_lossy().to_string(),
        app_version,
        port,
        token,
        started_at: unix_timestamp(),
    };

    #[cfg(target_os = "windows")]
    let process_job = match assign_child_to_kill_on_close_job(&child) {
        Ok(job) => job,
        Err(error) => {
            terminate_child_process(&mut child, ownership.server_process_group);
            return Err(error.into());
        }
    };

    if let Err(error) = write_runtime_state(app, &ownership) {
        terminate_child_process(&mut child, ownership.server_process_group);
        return Err(error.into());
    }

    if let Err(error) = wait_for_local_server(&mut child, &ownership) {
        terminate_child_process(&mut child, ownership.server_process_group);
        remove_runtime_state_if_owned(app, &ownership);
        return Err(error.into());
    }

    let state = app.state::<NextServerState>();
    *state.process.lock().expect("next server state poisoned") = Some(NextServerProcess {
        child,
        #[cfg(target_os = "windows")]
        _job: process_job,
        port,
        ownership,
    });
    append_startup_log(
        app,
        format!(
            "Bundled Next server authenticated and ready. shell_pid={shell_pid}, server_pid={server_pid}, port={port}, startup_duration_ms={}",
            started.elapsed().as_millis()
        ),
    );

    Ok(port)
}

fn create_main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let url = tauri::Url::parse(&format!("http://127.0.0.1:{port}/login"))?;
    let runtime_mode = if cfg!(debug_assertions) {
        "tauri-dev"
    } else {
        "tauri-packaged"
    };
    let runtime_architecture = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let runtime_script = format!(
        "window.__BEZGROW_DESKTOP__ = true; window.__BEZGROW_RUNTIME__ = \"{runtime_mode}\"; window.__BEZGROW_ARCH__ = \"{runtime_architecture}\"; window.isTauri = true;"
    );

    if let Some(window) = app.get_webview_window("main") {
        window.navigate(url)?;
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        return Ok(());
    }

    let builder = tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Bezgrow ERP")
        .inner_size(1360.0, 860.0)
        .min_inner_size(1100.0, 720.0)
        .resizable(true)
        .fullscreen(false)
        .initialization_script(runtime_script);

    #[cfg(target_os = "windows")]
    let builder = builder.data_directory(managed_data_directory(app, "WebView")?);

    builder.build()?;

    Ok(())
}

fn start_server_with_retries<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<u16, String> {
    let state = app.state::<NextServerState>();
    let _startup_guard = state
        .startup
        .lock()
        .map_err(|_| "The Bezgrow runtime startup lock is unavailable.".to_string())?;
    state.shutting_down.store(false, Ordering::SeqCst);

    #[cfg(debug_assertions)]
    {
        return start_next_server(app).map_err(|error| error.to_string());
    }

    #[cfg(not(debug_assertions))]
    {
        let existing = state
            .process
            .lock()
            .map_err(|_| "The Bezgrow runtime process lock is unavailable.".to_string())?
            .take();
        if let Some(mut existing) = existing {
            let exited = existing.child.try_wait().ok().flatten();
            if exited.is_none() && local_runtime_responds(&existing.ownership) {
                let port = existing.port;
                *state.process.lock().map_err(|_| {
                    "The Bezgrow runtime process lock is unavailable.".to_string()
                })? = Some(existing);
                append_startup_log_handle(
                    app,
                    format!("Reusing authenticated Bezgrow runtime on port {port}"),
                );
                return Ok(port);
            }
            let server_pid = existing.child.id();
            let status = terminate_child_process(
                &mut existing.child,
                existing.ownership.server_process_group,
            );
            remove_runtime_state_if_owned(app, &existing.ownership);
            append_startup_log_handle(
                app,
                format!(
                    "Removed unhealthy in-memory runtime before recovery. server_pid={server_pid}, child_exit={}",
                    status
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                ),
            );
        }

        const RETRY_DELAYS: [Duration; 2] =
            [Duration::from_millis(200), Duration::from_millis(500)];
        let mut errors = Vec::new();

        for attempt in 1..=3 {
            match start_next_server(app) {
                Ok(port) => {
                    if attempt > 1 {
                        append_startup_log(
                            app,
                            format!(
                                "Bundled Next server recovered successfully on startup attempt {attempt}"
                            ),
                        );
                    }
                    return Ok(port);
                }
                Err(error) => {
                    let message = error.to_string().replace(['\r', '\n'], " ");
                    append_startup_log(
                        app,
                        format!(
                            "Bundled Next server startup attempt {attempt}/3 failed: {message}"
                        ),
                    );
                    errors.push(format!("attempt {attempt}: {message}"));
                    if let Some(delay) = RETRY_DELAYS.get(attempt - 1) {
                        thread::sleep(*delay);
                    }
                }
            }
        }

        Err(format!(
            "The bundled Bezgrow runtime did not recover after 3 attempts. {}",
            errors.join(" | ")
        ))
    }
}

fn launch_desktop_ui<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let port = start_server_with_retries(app)?;
    create_main_window(app, port).map_err(|error| error.to_string())?;
    if let Some(recovery) = app.get_webview_window("startup-error") {
        let _ = recovery.hide();
    }
    append_startup_log(
        app,
        format!("Bezgrow desktop window opened successfully on managed runtime port {port}"),
    );
    Ok(())
}

#[tauri::command]
fn desktop_retry_startup<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    append_startup_log_handle(&app, "Customer requested bundled runtime recovery");
    launch_desktop_ui(&app)?;
    start_runtime_supervisor(app);
    Ok(())
}

#[cfg(not(debug_assertions))]
fn start_runtime_supervisor<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    let state = app.state::<NextServerState>();
    if state.supervisor_started.swap(true, Ordering::SeqCst) {
        return;
    }

    thread::spawn(move || {
        let mut failed_health_checks = 0_u8;
        loop {
            thread::sleep(Duration::from_secs(1));
            let state = app.state::<NextServerState>();
            if state.shutting_down.load(Ordering::SeqCst) {
                return;
            }

            let (ownership, exited) = {
                let mut process_guard = state.process.lock().expect("next server state poisoned");
                let Some(process) = process_guard.as_mut() else {
                    continue;
                };
                let exited = process.child.try_wait().ok().flatten();
                (process.ownership.clone(), exited)
            };
            let port = ownership.port;

            if exited.is_none() && local_runtime_responds(&ownership) {
                failed_health_checks = 0;
                continue;
            }
            failed_health_checks = failed_health_checks.saturating_add(1);
            if exited.is_none() && failed_health_checks < 3 {
                continue;
            }
            failed_health_checks = 0;

            let failed_process = state
                .process
                .lock()
                .expect("next server state poisoned")
                .take();
            if let Some(mut failed_process) = failed_process {
                let status = terminate_child_process(
                    &mut failed_process.child,
                    failed_process.ownership.server_process_group,
                );
                remove_runtime_state_if_owned(&app, &failed_process.ownership);
                append_startup_log_handle(
                    &app,
                    format!(
                        "Failed bundled child was reaped. server_pid={}, child_exit={}",
                        failed_process.ownership.server_pid,
                        status
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "unknown".to_string())
                    ),
                );
            }

            append_startup_log_handle(
                &app,
                format!(
                    "Bundled runtime health check failed on port {port}; hiding the ERP window and starting automatic recovery"
                ),
            );
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.hide();
            }
            let initial_message =
                "Bezgrow detected that its bundled runtime stopped responding. Automatic recovery is in progress.";
            let _ = create_startup_error_window(&app, initial_message);

            match launch_desktop_ui(&app) {
                Ok(()) => {
                    append_startup_log_handle(
                        &app,
                        "Bundled runtime supervisor restored the ERP window",
                    );
                }
                Err(error) => {
                    append_startup_log_handle(
                        &app,
                        format!(
                            "Automatic bundled runtime recovery failed: {}",
                            error.replace(['\r', '\n'], " ")
                        ),
                    );
                    let _ = create_startup_error_window(&app, &error);
                }
            }
        }
    });
}

#[cfg(debug_assertions)]
fn start_runtime_supervisor<R: tauri::Runtime>(_app: tauri::AppHandle<R>) {}

fn focus_running_bezgrow<R: tauri::Runtime>(app: &tauri::AppHandle<R>, reason: &str) {
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("startup-error"));
    if let Some(window) = window {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    #[cfg(target_os = "macos")]
    if let Some(marker) = MainThreadMarker::new() {
        #[allow(deprecated)]
        NSApplication::sharedApplication(marker).activateIgnoringOtherApps(true);
    }
    append_startup_log_handle(
        app,
        format!("Existing Bezgrow window restored and focused. reason={reason}"),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    {
        append_early_startup_log("Bezgrow native process entered");
        if let Err(error) = configure_windows_app_identity() {
            append_early_startup_log(error);
        }
    }

    let builder = tauri::Builder::default();
    #[cfg(bezgrow_updater_enabled)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_running_bezgrow(app, "second launch");
        }))
        .setup(|app| {
            rotate_startup_log(app);
            append_startup_log(app, "Tauri setup entered");
            app.manage(NextServerState::new());
            app.manage(DesktopOperationState::new());
            let managed_data = match prepare_managed_data(app.handle()) {
                Ok(preparation) => preparation,
                Err(error) => {
                    append_startup_log(
                        app,
                        format!("Managed data preparation failed before server startup: {error}"),
                    );
                    return Err(error.into());
                }
            };
            let migration_occurred = managed_data.legacy_migration_occurred;
            let migration_source = managed_data
                .legacy_migration_source
                .clone()
                .unwrap_or_else(|| "none".to_string());
            app.manage(managed_data);
            let app_data = managed_app_data_root(app.handle())?;
            let database = local_database_path(app.handle())?;
            let device_source = if app_data
                .join(INSTALLATION_DIRECTORY)
                .join(DEVICE_ID_FILENAME)
                .is_file()
            {
                "canonical-installation-file"
            } else {
                "pending-native-or-signed-licence-recovery"
            };
            append_startup_log(
                app,
                format!(
                    "Persistence diagnostics: version={} app_data={} database={} device_id_source={} license_state_source=sqlite:license_state legacy_migration_occurred={} legacy_migration_source={}",
                    app.package_info().version,
                    app_data.display(),
                    database.display(),
                    device_source,
                    migration_occurred,
                    migration_source,
                ),
            );

            let app_handle = app.handle().clone();
            match launch_desktop_ui(&app_handle) {
                Ok(()) => {
                    start_runtime_supervisor(app_handle);
                }
                Err(error) => {
                    append_startup_log(
                        app,
                        format!("Startup failed before main window opened: {error}"),
                    );

                    if let Err(window_error) = create_startup_error_window(&app.handle(), &error) {
                        append_startup_log(
                            app,
                            format!("Unable to show startup error window: {window_error}"),
                        );
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let app = window.app_handle().clone();
                if window.label() == "platform-admin" || window.label() == "invoice-native-print" {
                    append_startup_log_handle(
                        &app,
                        format!(
                            "Auxiliary window {} closed; local ERP remains open",
                            window.label()
                        ),
                    );
                    return;
                }
                api.prevent_close();
                if window.label() == "startup-error" {
                    orderly_shutdown(&app, "startup recovery window close");
                    app.exit(1);
                    return;
                }
                append_startup_log_handle(
                    &app,
                    format!(
                        "Native close requested for window={}; SQLite command connections are closed and full shutdown started",
                        window.label()
                    ),
                );
                orderly_shutdown(&app, "main window close");
                app.exit(0);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            desktop_database_diagnostics,
            desktop_database_backup,
            desktop_prepare_update,
            desktop_download_verified_release,
            desktop_cancel_update_preparation,
            desktop_restart_after_update,
            desktop_execute,
            desktop_select,
            desktop_execute_transaction,
            desktop_startup_log,
            store_secret,
            read_secret,
            delete_secret,
            desktop_get_or_create_device_id,
            desktop_platform_admin_proof,
            close_platform_admin,
            desktop_copy_text,
            desktop_save_file,
            desktop_prepare_invoice_share,
            desktop_pick_business_logo,
            desktop_remove_business_logo,
            desktop_read_local_asset,
            desktop_open_pdf_for_print,
            desktop_reveal_file,
            desktop_open_file,
            desktop_export_backup,
            desktop_restore_backup,
            desktop_exit,
            desktop_retry_startup,
            open_external_url,
            open_platform_admin
        ])
        .build(tauri::generate_context!())
        .expect("error while building Bezgrow ERP")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { code, .. } => {
                let cause = if code.is_some() {
                    "programmatic exit or restart"
                } else {
                    "menu Quit, Cmd+Q, logout, or operating-system quit"
                };
                orderly_shutdown(app, cause);
            }
            tauri::RunEvent::Exit => {
                orderly_shutdown(app, "event loop exit");
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                focus_running_bezgrow(app, "macOS dock reopen");
            }
            _ => {}
        });
}
