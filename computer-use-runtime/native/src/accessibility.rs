use serde_json::{Value, json};
use windows::{
    Win32::{Foundation::HWND, System::Com::*, UI::Accessibility::*},
    core::Interface,
};
unsafe fn matches_locator(el: &IUIAutomationElement, locator: &str) -> bool {
    unsafe {
        if let Some(named) = locator.strip_prefix("@name:") {
            if let Some((kind, name)) = named.split_once(':') {
                return el.CurrentControlType().map(|v| v.0).ok() == kind.parse::<i32>().ok()
                    && el.CurrentName().map(|v| v.to_string()).unwrap_or_default() == name;
            }
            return false;
        }
        el.CurrentAutomationId()
            .map(|v| v.to_string())
            .unwrap_or_default()
            == locator
    }
}
pub fn inspect(handle: usize) -> Result<Value, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
        let root = automation
            .ElementFromHandle(HWND(handle as _))
            .map_err(|e| e.to_string())?;
        // Each inspection obtains a fresh provider snapshot. Fetching every
        // property separately can consume the observation deadline during a
        // dialog transition. Never retain this cache between inspections.
        let cache = automation.CreateCacheRequest().map_err(|e| e.to_string())?;
        cache
            .SetTreeScope(TreeScope_Element)
            .map_err(|e| e.to_string())?;
        for property in [
            UIA_IsPasswordPropertyId,
            UIA_NamePropertyId,
            UIA_AutomationIdPropertyId,
            UIA_BoundingRectanglePropertyId,
            UIA_ControlTypePropertyId,
            UIA_HasKeyboardFocusPropertyId,
            UIA_IsOffscreenPropertyId,
            UIA_ValueValuePropertyId,
            UIA_ValueIsReadOnlyPropertyId,
        ] {
            cache.AddProperty(property).map_err(|e| e.to_string())?;
        }
        for pattern in [UIA_InvokePatternId, UIA_ValuePatternId, UIA_TextPatternId] {
            cache.AddPattern(pattern).map_err(|e| e.to_string())?;
        }
        let all = root
            .FindAllBuildCache(
                TreeScope_Descendants,
                &automation
                    .CreateTrueCondition()
                    .map_err(|e| e.to_string())?,
                &cache,
            )
            .map_err(|e| e.to_string())?;
        let mut elements = Vec::new();
        for i in 0..all.Length().unwrap_or(0).min(500) {
            let Ok(el) = all.GetElement(i) else { continue };
            if el.CachedIsPassword().unwrap_or_default().as_bool() {
                continue;
            }
            let name = el.CachedName().map(|v| v.to_string()).unwrap_or_default();
            let id = el
                .CachedAutomationId()
                .map(|v| v.to_string())
                .unwrap_or_default();
            let Ok(rect) = el.CachedBoundingRectangle() else {
                continue;
            };
            let mut value = String::new();
            let mut selection = String::new();
            let mut actions = vec!["click"];
            if el.GetCachedPattern(UIA_InvokePatternId).is_ok() {
                actions.push("invoke");
            }
            if let Ok(pattern) = el.GetCachedPattern(UIA_ValuePatternId)
                && let Ok(p) = pattern.cast::<IUIAutomationValuePattern>()
            {
                if !p.CachedIsReadOnly().unwrap_or_default().as_bool() {
                    actions.push("fill");
                }
                value = p.CachedValue().map(|v| v.to_string()).unwrap_or_default();
            }
            if let Ok(pattern) = el.GetCachedPattern(UIA_TextPatternId)
                && let Ok(p) = pattern.cast::<IUIAutomationTextPattern>()
                && let Ok(range) = p.DocumentRange()
            {
                value = range
                    .GetText(8192)
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                if let Ok(selected) = p.GetSelection().and_then(|ranges| ranges.GetElement(0))
                    && let Ok(prefix) = range.Clone()
                    && prefix
                        .MoveEndpointByRange(
                            TextPatternRangeEndpoint_End,
                            &selected,
                            TextPatternRangeEndpoint_Start,
                        )
                        .is_ok()
                {
                    let offset = prefix
                        .GetText(8192)
                        .map(|s| s.to_string().encode_utf16().count())
                        .unwrap_or(0);
                    let selected_text = selected
                        .GetText(8192)
                        .map(|s| s.to_string())
                        .unwrap_or_default();
                    selection = format!("{offset}:{}", selected_text);
                }
            }
            elements.push(json!({"index":i,"id":id,"name":name,"value":value,"selection":selection,"actions":actions,"controlType":el.CachedControlType().map(|v|v.0).unwrap_or(0),"focused":el.CachedHasKeyboardFocus().unwrap_or_default().as_bool(),"offscreen":el.CachedIsOffscreen().unwrap_or_default().as_bool(),"bounds":{"x":rect.left,"y":rect.top,"width":rect.right-rect.left,"height":rect.bottom-rect.top}}));
        }
        Ok(json!(elements))
    }
}
pub fn focus(handle: usize) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
        automation
            .ElementFromHandle(HWND(handle as _))
            .map_err(|e| e.to_string())?
            .SetFocus()
            .map_err(|e| e.to_string())
    }
}
pub fn invoke(handle: usize, automation_id: &str) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
        let root = automation
            .ElementFromHandle(HWND(handle as _))
            .map_err(|e| e.to_string())?;
        let all = root
            .FindAll(
                TreeScope_Descendants,
                &automation
                    .CreateTrueCondition()
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        let mut found = Vec::new();
        for i in 0..all.Length().unwrap_or(0).min(500) {
            if let Ok(el) = all.GetElement(i)
                && matches_locator(&el, automation_id)
                && !el.CurrentIsOffscreen().unwrap_or_default().as_bool()
            {
                found.push(el)
            }
        }
        if found.len() != 1 {
            return Err("UIA locator is missing or ambiguous".into());
        }
        let pattern = found[0]
            .GetCurrentPattern(UIA_InvokePatternId)
            .map_err(|e| e.to_string())?
            .cast::<IUIAutomationInvokePattern>()
            .map_err(|e| e.to_string())?;
        pattern.Invoke().map_err(|e| e.to_string())?;
        Ok(())
    }
}
pub fn select(handle: usize, automation_id: &str, item_name: &str) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
        let root = automation
            .ElementFromHandle(HWND(handle as _))
            .map_err(|e| e.to_string())?;
        let condition = automation
            .CreateTrueCondition()
            .map_err(|e| e.to_string())?;
        let all = root
            .FindAll(TreeScope_Descendants, &condition)
            .map_err(|e| e.to_string())?;
        let mut found = Vec::new();
        for i in 0..all.Length().unwrap_or(0).min(500) {
            if let Ok(el) = all.GetElement(i)
                && matches_locator(&el, automation_id)
                && !el.CurrentIsOffscreen().unwrap_or_default().as_bool()
            {
                found.push(el)
            }
        }
        if found.len() != 1 {
            return Err("Selection locator missing or ambiguous".into());
        }
        let combo = &found[0];
        combo
            .GetCurrentPattern(UIA_ExpandCollapsePatternId)
            .map_err(|e| e.to_string())?
            .cast::<IUIAutomationExpandCollapsePattern>()
            .map_err(|e| e.to_string())?
            .Expand()
            .map_err(|e| e.to_string())?;
        let descendants = combo
            .FindAll(TreeScope_Descendants, &condition)
            .map_err(|e| e.to_string())?;
        for i in 0..descendants.Length().unwrap_or(0).min(100) {
            let el = descendants.GetElement(i).map_err(|e| e.to_string())?;
            if el.CurrentName().map(|v| v.to_string()).unwrap_or_default() == item_name {
                el.GetCurrentPattern(UIA_SelectionItemPatternId)
                    .map_err(|e| e.to_string())?
                    .cast::<IUIAutomationSelectionItemPattern>()
                    .map_err(|e| e.to_string())?
                    .Select()
                    .map_err(|e| e.to_string())?;
                combo
                    .GetCurrentPattern(UIA_ExpandCollapsePatternId)
                    .map_err(|e| e.to_string())?
                    .cast::<IUIAutomationExpandCollapsePattern>()
                    .map_err(|e| e.to_string())?
                    .Collapse()
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
        Err("Requested selection item not found".into())
    }
}
pub fn fill(handle: usize, automation_id: &str, value: &str) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
        let root = automation
            .ElementFromHandle(HWND(handle as _))
            .map_err(|e| e.to_string())?;
        let all = root
            .FindAll(
                TreeScope_Descendants,
                &automation
                    .CreateTrueCondition()
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        let mut found = Vec::new();
        for i in 0..all.Length().unwrap_or(0).min(500) {
            if let Ok(el) = all.GetElement(i)
                && matches_locator(&el, automation_id)
                && !el.CurrentIsOffscreen().unwrap_or_default().as_bool()
            {
                found.push(el)
            }
        }
        if found.len() != 1 {
            return Err("Value locator missing or ambiguous".into());
        }
        let pattern = found[0]
            .GetCurrentPattern(UIA_ValuePatternId)
            .map_err(|e| e.to_string())?
            .cast::<IUIAutomationValuePattern>()
            .map_err(|e| e.to_string())?;
        if pattern
            .CurrentIsReadOnly()
            .map_err(|e| e.to_string())?
            .as_bool()
        {
            return Err("Value control is read-only".into());
        }
        pattern
            .SetValue(&windows::core::BSTR::from(value))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
