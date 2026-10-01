use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::VecDeque,
    mem::zeroed,
    ptr::null_mut,
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    System::Threading::GetCurrentThreadId,
    UI::{Accessibility::*, WindowsAndMessaging::*},
};

#[derive(Default)]
struct State {
    target: usize,
    sequence: u64,
    events: VecDeque<Value>,
    thread: u32,
    ready: bool,
    available: bool,
    stopping: bool,
}
thread_local! { static WATCH: RefCell<Option<Arc<Mutex<State>>>> = const { RefCell::new(None) }; }

unsafe extern "system" fn changed(
    _: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _: u32,
    source_time: u32,
) {
    WATCH.with(|watch| {
        let borrowed = watch.borrow();
        let Some(shared) = borrowed.as_ref() else { return };
        let Ok(mut state) = shared.lock() else { return };
        let target = state.target as HWND;
        if target.is_null() || hwnd.is_null() { return; }
        let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
        let mut owner = root;
        let mut belongs = root == target;
        for _ in 0..8 {
            if belongs || owner.is_null() { break; }
            owner = unsafe { GetWindow(owner, GW_OWNER) };
            belongs = owner == target;
        }
        if !belongs { return; }
        let mut bounds: RECT = unsafe { zeroed() };
        let has_bounds = unsafe { GetWindowRect(hwnd, &mut bounds) } != 0;
        state.sequence += 1;
        let sequence = state.sequence;
        state.events.push_back(json!({"sequence":sequence,"event":event,"handle":hwnd as usize,"object":object,"child":child,"sourceTime":source_time,"region":if has_bounds { json!({"x":bounds.left,"y":bounds.top,"width":bounds.right-bounds.left,"height":bounds.bottom-bounds.top}) } else {Value::Null}}));
        while state.events.len() > 128 { state.events.pop_front(); }
    });
}

pub struct EventStream {
    state: Arc<Mutex<State>>,
    worker: Option<JoinHandle<()>>,
}
impl EventStream {
    pub fn new() -> Self {
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let worker = thread::spawn(move || {
            WATCH.with(|watch| *watch.borrow_mut() = Some(shared.clone()));
            let mut message: MSG = unsafe { zeroed() };
            // Create this thread's queue before publishing readiness for shutdown.
            unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE) };
            let hook = unsafe {
                SetWinEventHook(
                    EVENT_MIN,
                    EVENT_MAX,
                    null_mut(),
                    Some(changed),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                )
            };
            if let Ok(mut state) = shared.lock() {
                state.thread = unsafe { GetCurrentThreadId() };
                state.available = !hook.is_null();
                state.ready = true;
            }
            if !hook.is_null() {
                while !shared.lock().map(|state| state.stopping).unwrap_or(true) {
                    for _ in 0..64 {
                        if unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) } == 0 {
                            break;
                        }
                        unsafe {
                            TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                unsafe { UnhookWinEvent(hook) };
            }
            WATCH.with(|watch| *watch.borrow_mut() = None);
        });
        for _ in 0..100 {
            if state.lock().map(|state| state.ready).unwrap_or(true) {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        Self {
            state,
            worker: Some(worker),
        }
    }
    pub fn watch(&self, target: usize) {
        if let Ok(mut state) = self.state.lock()
            && state.target != target
        {
            state.target = target;
            state.sequence += 1;
            state.events.clear();
        }
    }
    pub fn snapshot(&self) -> Value {
        match self.state.lock() {
            Ok(state) => {
                json!({"available":state.available,"target":state.target,"sequence":state.sequence,"events":state.events})
            }
            Err(_) => json!({"available":false,"reason":"Native event queue unavailable"}),
        }
    }
}
impl Drop for EventStream {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.stopping = true;
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
