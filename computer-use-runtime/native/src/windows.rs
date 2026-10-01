use super::*;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeSet,
    mem::{size_of, zeroed},
    ptr::null_mut,
    thread,
    time::Duration,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
thread_local! {
    static HELD_KEYS: RefCell<BTreeSet<u16>> = const { RefCell::new(BTreeSet::new()) };
    static HELD_UNICODE: RefCell<BTreeSet<u16>> = const { RefCell::new(BTreeSet::new()) };
    static HELD_MOUSE: Cell<u32> = const { Cell::new(0) };
}
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::{RemoteDesktop::*, Threading::*},
    UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn handle(v: &Value) -> HWND {
    v.as_u64().unwrap_or(0) as usize as HWND
}
fn coordinate(args: &Value, key: &str) -> Result<i32, String> {
    i32::try_from(args[key].as_i64().ok_or("Missing integer coordinate")?)
        .map_err(|_| "Coordinate exceeds supported range".into())
}
fn normalized_axis(position: i64, origin: i64, extent: i64) -> Result<i32, String> {
    let offset = position - origin;
    if !(1..=65536).contains(&extent) || offset < 0 || offset >= extent {
        return Err("Point outside representable virtual desktop".into());
    }
    // Target the middle of the pixel's normalized range, avoiding rounding
    // into the adjacent pixel on monitors with positive or negative origins.
    Ok(((offset * 65536 + 32768) / extent) as i32)
}
fn rect(h: HWND) -> RECT {
    let mut r = unsafe { zeroed() };
    unsafe { GetWindowRect(h, &mut r) };
    r
}
fn frame(h: HWND) -> Value {
    let r = rect(h);
    json!({"x":r.left,"y":r.top,"width":r.right-r.left,"height":r.bottom-r.top,"scale":unsafe{GetDpiForWindow(h)} as f64/96.0})
}
fn title(h: HWND) -> String {
    let mut b = [0u16; 1024];
    let n = unsafe { GetWindowTextW(h, b.as_mut_ptr(), 1024) };
    String::from_utf16_lossy(&b[..n.max(0) as usize])
}
fn window_pid(h: HWND) -> u32 {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(h, &mut pid) };
    pid
}
fn process_path(pid: u32) -> String {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return String::new();
    }
    let mut path = vec![0u16; 4096];
    let mut size = path.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut size) };
    unsafe { CloseHandle(process) };
    if ok != 0 {
        String::from_utf16_lossy(&path[..size as usize])
    } else {
        String::new()
    }
}
unsafe extern "system" fn hosted_app(h: HWND, l: LPARAM) -> i32 {
    let mut name = [0u16; 256];
    let length = unsafe { GetClassNameW(h, name.as_mut_ptr(), name.len() as i32) };
    if String::from_utf16_lossy(&name[..length.max(0) as usize]) == "Windows.UI.Core.CoreWindow" {
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(h, &mut pid) };
        let path = process_path(pid);
        if !path.is_empty() {
            unsafe { &mut *(l as *mut BTreeSet<String>) }.insert(path);
        }
    }
    1
}
unsafe extern "system" fn enumerate(h: HWND, l: LPARAM) -> i32 {
    if unsafe { IsWindowVisible(h) } != 0 {
        let t = title(h);
        if !t.is_empty() {
            let list = unsafe { &mut *(l as *mut Vec<Value>) };
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(h, &mut pid) };
            let executable = process_path(pid);
            let mut hosted: BTreeSet<String> = BTreeSet::new();
            // UWP windows belong to ApplicationFrameHost. Their CoreWindow child
            // identifies the app. Keep the root PID for native target validation.
            if executable
                .to_lowercase()
                .ends_with("\\applicationframehost.exe")
            {
                unsafe {
                    EnumChildWindows(
                        h,
                        Some(hosted_app),
                        &mut hosted as *mut BTreeSet<String> as LPARAM,
                    )
                };
            }
            let app_executable = if hosted.len() == 1 {
                hosted.iter().next().unwrap().clone()
            } else {
                executable.clone()
            };
            list.push(json!({"handle":h as usize,"title":t,"pid":pid,"executable":executable,"appExecutable":app_executable,"frame":frame(h)}));
        }
    }
    1
}
fn key(vk: u16, up: bool) -> Result<(), String> {
    unsafe {
        let mut i: INPUT = zeroed();
        i.r#type = INPUT_KEYBOARD;
        i.Anonymous.ki = KEYBDINPUT {
            wVk: vk,
            wScan: 0,
            dwFlags: (if up { KEYEVENTF_KEYUP } else { 0 })
                | if [
                    VK_HOME, VK_END, VK_LEFT, VK_RIGHT, VK_UP, VK_DOWN, VK_INSERT, VK_DELETE,
                    VK_PRIOR, VK_NEXT,
                ]
                .contains(&vk)
                {
                    KEYEVENTF_EXTENDEDKEY
                } else {
                    0
                },
            time: 0,
            dwExtraInfo: 0,
        };
        if SendInput(1, &i, size_of::<INPUT>() as i32) != 1 {
            return Err("SendInput did not acknowledge keyboard event".into());
        }
        thread::sleep(Duration::from_millis(20));
    }
    HELD_KEYS.with(|held| {
        if up {
            held.borrow_mut().remove(&vk);
        } else {
            held.borrow_mut().insert(vk);
        }
    });
    Ok(())
}
fn mouse(flags: u32, data: u32) -> Result<(), String> {
    unsafe {
        let mut i: INPUT = zeroed();
        i.r#type = INPUT_MOUSE;
        i.Anonymous.mi = MOUSEINPUT {
            dx: 0,
            dy: 0,
            mouseData: data,
            dwFlags: flags,
            time: 0,
            dwExtraInfo: 0,
        };
        if SendInput(1, &i, size_of::<INPUT>() as i32) != 1 {
            return Err("SendInput did not acknowledge mouse event".into());
        }
        thread::sleep(Duration::from_millis(20));
    }
    HELD_MOUSE.with(|held| {
        let mut buttons = held.get();
        for (down, up) in [
            (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        ] {
            if flags & down != 0 {
                buttons |= up;
            }
            if flags & up != 0 {
                buttons &= !up;
            }
        }
        held.set(buttons);
    });
    Ok(())
}
fn unicode(scan: u16, up: bool) -> Result<(), String> {
    unsafe {
        let mut input: INPUT = zeroed();
        input.r#type = INPUT_KEYBOARD;
        input.Anonymous.ki = KEYBDINPUT {
            wVk: 0,
            wScan: scan,
            dwFlags: KEYEVENTF_UNICODE | if up { KEYEVENTF_KEYUP } else { 0 },
            time: 0,
            dwExtraInfo: 0,
        };
        if SendInput(1, &input, size_of::<INPUT>() as i32) != 1 {
            return Err("SendInput did not acknowledge Unicode input".into());
        }
    }
    HELD_UNICODE.with(|held| {
        if up {
            held.borrow_mut().remove(&scan);
        } else {
            held.borrow_mut().insert(scan);
        }
    });
    Ok(())
}
fn cleanup() -> Result<(), String> {
    let mut errors = Vec::new();
    let keys = HELD_KEYS.with(|held| held.borrow().iter().copied().collect::<Vec<_>>());
    for vk in keys {
        if let Err(error) = key(vk, true) {
            errors.push(error);
        }
    }
    let scans = HELD_UNICODE.with(|held| held.borrow().iter().copied().collect::<Vec<_>>());
    for scan in scans {
        if let Err(error) = unicode(scan, true) {
            errors.push(error);
        }
    }
    let buttons = HELD_MOUSE.with(|held| held.get());
    if buttons != 0
        && let Err(error) = mouse(buttons, 0)
    {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err("Held input cleanup failed: ".to_string() + &errors.join("; "))
    }
}
fn screenshot(h: HWND) -> Result<Vec<u8>, String> {
    unsafe {
        let r = rect(h);
        let w = r.right - r.left;
        let height = r.bottom - r.top;
        if w <= 0 || height <= 0 || w > 8192 || height > 8192 {
            return Err("Invalid capture dimensions".into());
        }
        let foreground = GetForegroundWindow() == h;
        let source = if foreground { null_mut() } else { h };
        let dc = if foreground {
            GetDC(source)
        } else {
            GetWindowDC(source)
        };
        let mem = CreateCompatibleDC(dc);
        let bitmap = CreateCompatibleBitmap(dc, w, height);
        let old = SelectObject(mem, bitmap as _);
        let ok = BitBlt(
            mem,
            0,
            0,
            w,
            height,
            dc,
            if foreground { r.left } else { 0 },
            if foreground { r.top } else { 0 },
            SRCCOPY | CAPTUREBLT,
        );
        let mut info: BITMAPINFO = zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..zeroed()
        };
        let mut pixels = vec![0u8; (w * height * 4) as usize];
        SelectObject(mem, old);
        let lines = GetDIBits(
            mem,
            bitmap,
            0,
            height as u32,
            pixels.as_mut_ptr() as _,
            &mut info,
            DIB_RGB_COLORS,
        );
        DeleteObject(bitmap as _);
        DeleteDC(mem);
        ReleaseDC(source, dc);
        if ok == 0 || lines != height {
            return Err("Capture failed".into());
        }
        let total = 54 + pixels.len();
        let mut bytes = Vec::with_capacity(total);
        bytes.extend(b"BM");
        bytes.extend((total as u32).to_le_bytes());
        bytes.extend([0u8; 4]);
        bytes.extend(54u32.to_le_bytes());
        bytes.extend(40u32.to_le_bytes());
        bytes.extend(w.to_le_bytes());
        bytes.extend((-height).to_le_bytes());
        bytes.extend(1u16.to_le_bytes());
        bytes.extend(32u16.to_le_bytes());
        bytes.extend([0u8; 24]);
        bytes.extend(pixels);
        Ok(bytes)
    }
}
pub struct Host {
    events: crate::events::EventStream,
    owner: String,
    generation: u64,
    manual: bool,
    mutex: HANDLE,
    last: Value,
    host: String,
    session: String,
    expires: u64,
}
impl Host {
    pub fn new() -> Self {
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        let mut sid = 0;
        unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut sid) };
        Self {
            events: crate::events::EventStream::new(),
            owner: String::new(),
            generation: 0,
            manual: false,
            mutex: null_mut(),
            last: Value::Null,
            host: std::env::var("COMPUTERNAME").unwrap_or_default(),
            session: format!("windows-{sid}"),
            expires: 0,
        }
    }
    fn release(&mut self) -> Result<(), String> {
        self.generation += 1;
        self.last = Value::Null;
        if let Err(error) = cleanup() {
            self.manual = true;
            return Err(error);
        }
        if !self.mutex.is_null() {
            unsafe {
                ReleaseMutex(self.mutex);
                CloseHandle(self.mutex)
            };
            self.mutex = null_mut();
        }
        self.owner.clear();
        Ok(())
    }
    pub fn call(&mut self, r: &Value) -> Result<Value, String> {
        let op = r["method"].as_str().unwrap_or("");
        let p = &r["params"];
        match op {
            "capabilities" => Ok(
                json!({"host":self.host,"session":self.session,"platform":"windows","operations":["observe","focus","click","type","key","drag","scroll","hold"],"backend":"rust-win32-v1","transport":"private-stdio"}),
            ),
            "windows" => {
                let mut list = Vec::<Value>::new();
                unsafe { EnumWindows(Some(enumerate), &mut list as *mut _ as LPARAM) };
                Ok(json!(list))
            }
            "resolve_target" => {
                let root = handle(&p["handle"]);
                if unsafe { IsWindow(root) } == 0 {
                    return Err("Stale root window".into());
                }
                let foreground = unsafe { GetForegroundWindow() };
                let mut owner = foreground;
                for _ in 0..8 {
                    if owner == root {
                        return Ok(
                            json!({"handle":foreground as usize,"root":root as usize,"owned":true}),
                        );
                    }
                    owner = unsafe { GetWindow(owner, GW_OWNER) };
                    if owner.is_null() {
                        break;
                    }
                }
                Ok(json!({"handle":root as usize,"root":root as usize,"owned":false}))
            }
            "acquire" => {
                if self.manual {
                    return Err("Manual takeover active".into());
                }
                let owner = p["runId"].as_str().ok_or("Missing runId")?;
                if !self.owner.is_empty() && self.owner != owner {
                    return Err("Lease owned".into());
                }
                if self.mutex.is_null() {
                    let name = wide(&format!("Local\\ComputerUseRuntime.Input.{}", self.session));
                    let m = unsafe { CreateMutexW(null_mut(), 0, name.as_ptr()) };
                    if m.is_null() {
                        return Err("Cannot create host mutex".into());
                    }
                    let wait = unsafe { WaitForSingleObject(m, 0) };
                    if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
                        unsafe { CloseHandle(m) };
                        return Err("Another process owns foreground input".into());
                    }
                    self.mutex = m;
                }
                self.owner = owner.into();
                self.generation += 1;
                self.expires = now() + 30000;
                Ok(json!({"generation":self.generation}))
            }
            "release" => {
                if p["runId"] == self.owner {
                    self.release()?;
                }
                Ok(json!({"released":true}))
            }
            "takeover" | "stop" => {
                self.manual = true;
                self.release()?;
                Ok(json!({"manual":true,"heldInputsReleased":true}))
            }
            "return" => {
                // Retain the mutex after failed cleanup. Returning control must
                // release any remaining owned input before admitting a new lease.
                self.release()?;
                self.manual = false;
                self.generation += 1;
                Ok(json!({"manual":false}))
            }
            "focus" => {
                let h = handle(&p["handle"]);
                if unsafe { IsWindow(h) } == 0 {
                    return Err("Stale window".into());
                }
                unsafe {
                    if IsIconic(h) != 0 {
                        ShowWindow(h, SW_RESTORE);
                    }
                    SetForegroundWindow(h);
                }
                // Activation across input queues is asynchronous. Do not attach
                // another application's queue, which can hang this worker.
                for _ in 0..15 {
                    if unsafe { GetForegroundWindow() } == h {
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                if unsafe { GetForegroundWindow() } != h {
                    let _ = crate::accessibility::focus(h as usize);
                    thread::sleep(Duration::from_millis(150));
                }
                Ok(json!({"focused":unsafe{GetForegroundWindow()}==h}))
            }
            "observe" => {
                let h = handle(&p["handle"]);
                if unsafe { IsWindow(h) } == 0 {
                    return Err("Stale target".into());
                }
                self.events.watch(h as usize);
                let bytes = screenshot(h)?;
                let revision = format!("{:x}", Sha256::digest(&bytes));
                let observation = json!({"id":format!("native-{}",now()),"host":self.host,"session":self.session,"target":h as usize,"at":now(),"revision":revision,"frame":frame(h),"focused":unsafe{GetForegroundWindow()}==h,"foreground":unsafe{GetForegroundWindow()} as usize,"foregroundTitle":title(unsafe{GetForegroundWindow()}),"title":title(h),"image":base64::engine::general_purpose::STANDARD.encode(bytes)});
                let mut observation = observation;
                observation["pid"] = json!(window_pid(h));
                observation["nativeEvents"] = self.events.snapshot();
                self.last = observation.clone();
                Ok(observation)
            }
            "accessibility" => crate::accessibility::inspect(handle(&p["handle"]) as usize),
            "fixture_text" => {
                let h = handle(&p["handle"]);
                if title(h) != "Computer use disposable editor" {
                    return Err("Evaluator restricted to disposable editor".into());
                }
                let child =
                    unsafe { FindWindowExW(h, null_mut(), wide("EDIT").as_ptr(), null_mut()) };
                let mut b = vec![0u16; 8192];
                let n =
                    unsafe { SendMessageW(child, WM_GETTEXT, b.len(), b.as_mut_ptr() as LPARAM) };
                Ok(json!({"text":String::from_utf16_lossy(&b[..n.max(0) as usize])}))
            }
            "fixture_state" => {
                let h = handle(&p["handle"]);
                if title(h) != "Computer use disposable editor"
                    || !process_path(window_pid(h))
                        .to_lowercase()
                        .ends_with("\\disposable-editor.exe")
                {
                    return Err("Evaluator restricted to owned disposable editor executable".into());
                }
                let child = unsafe { GetDlgItem(h, 101) };
                if child.is_null() {
                    return Err("Disposable edit control missing".into());
                }
                let mut text = vec![0u16; 8192];
                let mut start: u32 = 0;
                let mut end: u32 = 0;
                let mut cursor: POINT = unsafe { zeroed() };
                let mut gui: GUITHREADINFO = unsafe { zeroed() };
                gui.cbSize = size_of::<GUITHREADINFO>() as u32;
                let thread = unsafe { GetWindowThreadProcessId(h, null_mut()) };
                let n = unsafe {
                    SendMessageW(child, WM_GETTEXT, text.len(), text.as_mut_ptr() as LPARAM)
                };
                unsafe {
                    SendMessageW(
                        child,
                        0x00B0,
                        &mut start as *mut _ as WPARAM,
                        &mut end as *mut _ as LPARAM,
                    )
                };
                if unsafe { GetCursorPos(&mut cursor) } == 0
                    || unsafe { GetGUIThreadInfo(thread, &mut gui) } == 0
                {
                    return Err("Independent pointer/focus probe failed".into());
                }
                Ok(
                    json!({"text":String::from_utf16_lossy(&text[..n.max(0) as usize]),
                    "selectionStart":start,"selectionEnd":end,
                    "firstVisibleLine":unsafe{SendMessageW(child, 0x00CE, 0, 0)},
                    "scrollPosition":unsafe{GetScrollPos(child, SB_VERT)},
                    "editFrame":frame(child),"editHandle":child as usize,
                    "focusedHandle":gui.hwndFocus as usize,"cursor":{"x":cursor.x,"y":cursor.y},
                    "held":{"right":unsafe{GetAsyncKeyState(VK_RIGHT as i32)} < 0,
                    "control":unsafe{GetAsyncKeyState(VK_CONTROL as i32)} < 0,
                    "shift":unsafe{GetAsyncKeyState(VK_SHIFT as i32)} < 0,
                    "leftButton":unsafe{GetAsyncKeyState(VK_LBUTTON as i32)} < 0}}),
                )
            }
            "authorize" => {
                let operation = p["operation"].as_str().unwrap_or("");
                if !["click", "type", "key", "scroll"].contains(&operation) {
                    return Err("Unsupported external operation".into());
                }
                let h = handle(&p["target"]);
                let r = rect(h);
                if operation == "click" {
                    let x = p["args"]["x"].as_i64().ok_or("Invalid x")?;
                    let y = p["args"]["y"].as_i64().ok_or("Invalid y")?;
                    if x < 0
                        || y < 0
                        || x >= (r.right - r.left) as i64
                        || y >= (r.bottom - r.top) as i64
                    {
                        return Err("Point outside target".into());
                    }
                }
                if operation == "type" && p["args"]["text"].as_str().unwrap_or("").len() > 128 {
                    return Err("Text segment exceeds 128 bytes".into());
                }
                let mut a = p.clone();
                a["operation"] = json!("observe");
                self.execute(&a)
            }
            "execute" => self.execute(p),
            _ => Err(format!("Unknown method {op}")),
        }
    }
    fn execute(&mut self, a: &Value) -> Result<Value, String> {
        if let Err(reason) = self.preflight(a) {
            return Ok(
                json!({"phase":"rejected","actionId":a["id"],"runId":a["runId"],
                "backend":"rust-win32-v1","dispatched":false,"reason":reason}),
            );
        }
        let result = self.dispatch(a);
        if let Err(original) = &result
            && let Err(cleanup_error) = cleanup()
        {
            self.manual = true;
            self.generation += 1;
            self.last = Value::Null;
            return Err(format!("{original}; {cleanup_error}"));
        }
        result
    }
    fn preflight(&self, a: &Value) -> Result<(), String> {
        let h = handle(&a["target"]);
        if self.manual
            || self.owner.is_empty()
            || a["runId"] != self.owner
            || a["generation"].as_u64() != Some(self.generation)
            || now() > self.expires
        {
            return Err("Lease rejected".into());
        }
        if a["host"] != self.host || a["session"] != self.session {
            return Err("Wrong host/session".into());
        }
        if a["observationId"] != self.last["id"]
            || a["revision"] != self.last["revision"]
            || now() - self.last["at"].as_u64().unwrap_or(0) > 2000
        {
            return Err("Stale observation".into());
        }
        if self.last["target"] != a["target"]
            || self.last["pid"].as_u64() != Some(window_pid(h) as u64)
            || ["x", "y", "width", "height", "scale"]
                .iter()
                .any(|key| a["frame"][key].as_f64() != self.last["frame"][key].as_f64())
            || unsafe { IsWindow(h) } == 0
            || (unsafe { GetForegroundWindow() } != h && a["operation"] != "invoke")
            || frame(h) != self.last["frame"]
        {
            return Err("Target/focus/frame changed".into());
        }
        if now() > a["deadline"].as_u64().unwrap_or(0)
            || !["edit", "save"].contains(&a["scope"].as_str().unwrap_or(""))
        {
            return Err("Deadline/scope rejected".into());
        }
        let current = screenshot(h)?;
        if format!("{:x}", Sha256::digest(&current)) != self.last["revision"].as_str().unwrap_or("")
        {
            return Err("Target content changed after observation".into());
        }
        Ok(())
    }
    fn dispatch(&mut self, a: &Value) -> Result<Value, String> {
        let h = handle(&a["target"]);
        let r = rect(h);
        let args = &a["args"];
        let op = a["operation"].as_str().unwrap_or("");
        let start = Instant::now();
        let point = |x: i32, y: i32| -> Result<(), String> {
            if x < 0 || y < 0 || x >= r.right - r.left || y >= r.bottom - r.top {
                return Err("Point outside target".into());
            }
            unsafe {
                let screen_x = r.left + x;
                let screen_y = r.top + y;
                let screen_point = POINT {
                    x: screen_x,
                    y: screen_y,
                };
                let mut clipping: RECT = zeroed();
                if MonitorFromPoint(screen_point, MONITOR_DEFAULTTONULL).is_null()
                    || GetClipCursor(&mut clipping) == 0
                    || screen_x < clipping.left
                    || screen_x >= clipping.right
                    || screen_y < clipping.top
                    || screen_y >= clipping.bottom
                {
                    return Err("Pointer point is not available on a display or is clipped".into());
                }
                let dx = normalized_axis(
                    i64::from(screen_x),
                    i64::from(GetSystemMetrics(SM_XVIRTUALSCREEN)),
                    i64::from(GetSystemMetrics(SM_CXVIRTUALSCREEN)),
                )?;
                let dy = normalized_axis(
                    i64::from(screen_y),
                    i64::from(GetSystemMetrics(SM_YVIRTUALSCREEN)),
                    i64::from(GetSystemMetrics(SM_CYVIRTUALSCREEN)),
                )?;
                let mut input: INPUT = zeroed();
                input.r#type = INPUT_MOUSE;
                input.Anonymous.mi = MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_MOVE
                        | MOUSEEVENTF_ABSOLUTE
                        | MOUSEEVENTF_VIRTUALDESK
                        | MOUSEEVENTF_MOVE_NOCOALESCE,
                    time: 0,
                    dwExtraInfo: 0,
                };
                if SendInput(1, &input, size_of::<INPUT>() as i32) != 1 {
                    return Err("SendInput did not acknowledge pointer movement".into());
                }
            }
            Ok(())
        };
        match op {
            "observe" => {}
            "invoke" => {
                crate::accessibility::invoke(
                    h as usize,
                    args["locator"].as_str().ok_or("Missing UIA locator")?,
                )?;
            }
            "select" => {
                crate::accessibility::select(
                    h as usize,
                    args["locator"].as_str().ok_or("Missing UIA locator")?,
                    args["value"].as_str().ok_or("Missing selection value")?,
                )?;
            }
            "fill" => {
                crate::accessibility::fill(
                    h as usize,
                    args["locator"].as_str().ok_or("Missing UIA locator")?,
                    args["value"].as_str().ok_or("Missing value")?,
                )?;
            }
            "click" => {
                point(coordinate(args, "x")?, coordinate(args, "y")?)?;
                mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
                mouse(MOUSEEVENTF_LEFTUP, 0)?;
            }
            "type" => {
                let text = args["text"].as_str().ok_or("Missing text")?;
                if text.len() > 128 {
                    return Err("Text segment exceeds 128 bytes".into());
                }
                for c in text.encode_utf16() {
                    if unsafe { GetForegroundWindow() } != h
                        || now() > a["deadline"].as_u64().unwrap_or(0)
                    {
                        let _ = cleanup();
                        return Err("Focus or deadline changed during typing".into());
                    }
                    unicode(c, false)?;
                    unicode(c, true)?;
                    thread::sleep(Duration::from_millis(20));
                }
            }
            "key" | "hold" => {
                let vk = match args["key"].as_str().unwrap_or("") {
                    "F12" => {
                        if a["scope"] != "save" {
                            return Err("Save scope required".into());
                        }
                        VK_F12
                    }
                    "Enter" => VK_RETURN,
                    "Tab" => VK_TAB,
                    "Escape" => VK_ESCAPE,
                    "Space" => VK_SPACE,
                    "ArrowRight" => VK_RIGHT,
                    "ArrowLeft" => VK_LEFT,
                    "ArrowUp" => VK_UP,
                    "ArrowDown" => VK_DOWN,
                    "Home" => VK_HOME,
                    "End" => VK_END,
                    "Backspace" => VK_BACK,
                    "Delete" => VK_DELETE,
                    "PageUp" => VK_PRIOR,
                    "PageDown" => VK_NEXT,
                    "Shift+Tab" => {
                        key(VK_SHIFT, false)?;
                        key(VK_TAB, false)?;
                        key(VK_TAB, true)?;
                        key(VK_SHIFT, true)?;
                        0
                    }
                    "Control+C" | "Control+V" | "Control+Z" | "Control+F" | "Control+S"
                    | "Control+End" | "Control+L" | "Control+O" | "Control+Tab" => {
                        let chord = args["key"].as_str().unwrap();
                        if chord == "Control+S" && a["scope"] != "save" {
                            return Err("Save scope required".into());
                        }
                        let code = match chord {
                            "Control+C" => 67,
                            "Control+V" => 86,
                            "Control+Z" => 90,
                            "Control+F" => 70,
                            "Control+S" => 83,
                            "Control+L" => 76,
                            "Control+O" => 79,
                            "Control+Tab" => VK_TAB,
                            _ => VK_END,
                        };
                        key(VK_CONTROL, false)?;
                        key(code, false)?;
                        key(code, true)?;
                        key(VK_CONTROL, true)?;
                        0
                    }
                    "Control+Shift+S" => {
                        if a["scope"] != "save" {
                            return Err("Save scope required".into());
                        }
                        key(VK_CONTROL, false)?;
                        key(VK_SHIFT, false)?;
                        key(83, false)?;
                        key(83, true)?;
                        key(VK_SHIFT, true)?;
                        key(VK_CONTROL, true)?;
                        0
                    }
                    "Control+N" => {
                        key(VK_CONTROL, false)?;
                        key(78, false)?;
                        key(78, true)?;
                        key(VK_CONTROL, true)?;
                        0
                    }
                    "Control+Home" => {
                        key(VK_CONTROL, false)?;
                        key(VK_HOME, false)?;
                        key(VK_HOME, true)?;
                        key(VK_CONTROL, true)?;
                        0
                    }
                    "Control+Shift+End" => {
                        key(VK_CONTROL, false)?;
                        key(VK_SHIFT, false)?;
                        key(VK_END, false)?;
                        key(VK_END, true)?;
                        key(VK_SHIFT, true)?;
                        key(VK_CONTROL, true)?;
                        0
                    }
                    "Control+A" => {
                        key(VK_CONTROL, false)?;
                        key(65, false)?;
                        key(65, true)?;
                        key(VK_CONTROL, true)?;
                        0
                    }
                    _ => return Err("Key not in allowlist".into()),
                };
                if vk > 0 {
                    key(vk, false)?;
                    thread::sleep(Duration::from_millis(if op == "hold" {
                        args["ms"].as_u64().unwrap_or(50).min(250)
                    } else {
                        10
                    }));
                    key(vk, true)?;
                }
            }
            "scroll" => {
                mouse(
                    MOUSEEVENTF_WHEEL,
                    (args["amount"].as_i64().unwrap_or(-120) as i32) as u32,
                )?;
            }
            "drag" => {
                let x = coordinate(args, "x")?;
                let y = coordinate(args, "y")?;
                let dx = coordinate(args, "dx")?;
                let dy = coordinate(args, "dy")?;
                point(dx, dy)?;
                point(x, y)?;
                mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
                for i in 1..=10 {
                    if unsafe { GetForegroundWindow() } != h
                        || now() > a["deadline"].as_u64().unwrap_or(0)
                        || frame(h) != self.last["frame"]
                    {
                        let _ = cleanup();
                        return Err("Focus, deadline or frame changed during segment".into());
                    }
                    point(x + (dx - x) * i / 10, y + (dy - y) * i / 10)?;
                    thread::sleep(Duration::from_millis(10));
                }
                mouse(MOUSEEVENTF_LEFTUP, 0)?;
            }
            _ => return Err("Unsupported operation".into()),
        }
        self.expires = now() + 30000;
        Ok(
            json!({"acknowledged":true,"backend":"rust-win32-v1","dispatchMs":start.elapsed().as_secs_f64()*1000.0}),
        )
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

#[cfg(test)]
mod pointer_tests {
    use super::normalized_axis;

    #[test]
    fn normalized_pixels_round_trip_across_monitor_origins() {
        for (origin, extent) in [(0, 3840), (-1920, 3840), (-1080, 2160), (1920, 1920)] {
            for offset in 0..extent {
                let value = normalized_axis(origin + offset, origin, extent).unwrap();
                assert!((0..=65535).contains(&value));
                assert_eq!(i64::from(value) * extent / 65536, offset);
            }
        }
    }

    #[test]
    fn outside_and_unrepresentable_desktop_points_fail_closed() {
        for (position, origin, extent) in [
            (-1921, -1920, 3840),
            (1920, -1920, 3840),
            (0, 0, 0),
            (0, 0, 65537),
        ] {
            assert!(normalized_axis(position, origin, extent).is_err());
        }
        assert_eq!(normalized_axis(0, 0, 1).unwrap(), 32768);
    }
}
