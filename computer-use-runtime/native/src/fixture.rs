#[cfg(windows)]
fn main() {
    use std::ptr::null_mut;
    use windows_sys::Win32::{
        Foundation::*, System::LibraryLoader::*, UI::HiDpi::*, UI::WindowsAndMessaging::*,
    };
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    unsafe fn layout(h: HWND, dpi: u32) {
        let scaled = |value: i32| ((value as i64 * dpi as i64 + 48) / 96) as i32;
        for (id, x, y, width, height) in [
            (103, 24, 15, 600, 30),
            (101, 24, 55, 640, 330),
            (102, 24, 392, 240, 32),
        ] {
            let child = unsafe { GetDlgItem(h, id) };
            if !child.is_null() {
                unsafe {
                    MoveWindow(
                        child,
                        scaled(x),
                        scaled(y),
                        scaled(width),
                        scaled(height),
                        1,
                    )
                };
            }
        }
    }
    unsafe extern "system" fn proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        if m == WM_DESTROY {
            unsafe { PostQuitMessage(0) };
            return 0;
        }
        if m == WM_DPICHANGED {
            let suggested = unsafe { &*(l as *const RECT) };
            unsafe {
                SetWindowPos(
                    h,
                    null_mut(),
                    suggested.left,
                    suggested.top,
                    suggested.right - suggested.left,
                    suggested.bottom - suggested.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
                layout(h, (w & 0xffff) as u32);
            }
            return 0;
        }
        if m == WM_COMMAND && (w & 0xffff) == 102 {
            if let Ok(path) = std::env::var("CUR_EDITOR_SAVE_PATH") {
                let edit = unsafe { GetDlgItem(h, 101) };
                let mut text = vec![0u16; 8192];
                let n = unsafe {
                    SendMessageW(edit, WM_GETTEXT, text.len(), text.as_mut_ptr() as LPARAM)
                };
                let contents = String::from_utf16_lossy(&text[..n.max(0) as usize]);
                use std::io::Write;
                if let Ok(mut file) = std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(path)
                {
                    let _ = file.write_all(contents.as_bytes());
                    unsafe { SetWindowTextW(GetDlgItem(h, 102), wide("Saved").as_ptr()) };
                }
            }
            return 0;
        }
        unsafe { DefWindowProcW(h, m, w, l) }
    }
    unsafe {
        // This owned test process has no manifest or earlier UI initialization.
        if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) == 0 {
            panic!(
                "Cannot establish per-monitor-v2 test fixture: {}",
                GetLastError()
            );
        }
        let instance = GetModuleHandleW(null_mut());
        let name = wide("ComputerUseDisposable");
        let class = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: instance,
            lpszClassName: name.as_ptr(),
            hbrBackground: 6 as _,
            ..std::mem::zeroed()
        };
        RegisterClassW(&class);
        let h = CreateWindowExW(
            0,
            name.as_ptr(),
            wide("Computer use disposable editor").as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            120,
            120,
            720,
            480,
            null_mut(),
            null_mut(),
            instance,
            null_mut(),
        );
        if h.is_null() {
            panic!("Cannot create test fixture: {}", GetLastError());
        }
        let dpi = GetDpiForWindow(h);
        if dpi != 96 {
            SetWindowPos(
                h,
                null_mut(),
                0,
                0,
                ((720i64 * dpi as i64 + 48) / 96) as i32,
                ((480i64 * dpi as i64 + 48) / 96) as i32,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide("Runtime native verification. Disposable text only.").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            24,
            15,
            600,
            30,
            h,
            103 as _,
            instance,
            null_mut(),
        );
        let edit = CreateWindowExW(
            0,
            wide("EDIT").as_ptr(),
            wide("").as_ptr(),
            WS_CHILD
                | WS_VISIBLE
                | WS_BORDER
                | WS_VSCROLL
                | ES_MULTILINE as u32
                | ES_AUTOVSCROLL as u32,
            24,
            55,
            640,
            330,
            h,
            101 as _,
            instance,
            null_mut(),
        );
        if std::env::var("CUR_EDITOR_SAVE_PATH").is_ok() {
            CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide("Save new test artifact").as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                24,
                392,
                240,
                32,
                h,
                102 as _,
                instance,
                null_mut(),
            );
        }
        layout(h, GetDpiForWindow(h));
        SetForegroundWindow(h);
        windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus(edit);
        let mut message = std::mem::zeroed();
        while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}
#[cfg(not(windows))]
fn main() {
    eprintln!("UNSUPPORTED_PLATFORM");
}
