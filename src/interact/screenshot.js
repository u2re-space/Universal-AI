/** GDI+ virtual-screen PNG capture, inlined into every wrapped script. */
export const CAPTURE_LIBRARY = `SaveScreenshot(filePath) {
    ; SM_XVIRTUALSCREEN 76, SM_YVIRTUALSCREEN 77, SM_CXVIRTUALSCREEN 78, SM_CYVIRTUALSCREEN 79
    x := DllCall("user32\\GetSystemMetrics", "Int", 76, "Int")
    y := DllCall("user32\\GetSystemMetrics", "Int", 77, "Int")
    w := DllCall("user32\\GetSystemMetrics", "Int", 78, "Int")
    h := DllCall("user32\\GetSystemMetrics", "Int", 79, "Int")
    si := Buffer((A_PtrSize = 8) ? 24 : 16, 0)
    NumPut("UInt", 1, si, 0)
    token := 0
    status := DllCall("gdiplus\\GdiplusStartup", "Ptr*", &token, "Ptr", si, "Ptr", 0, "Int")
    if (status != 0)
        throw Error("screenshot failed")
    hdc := 0
    mdc := 0
    hbm := 0
    old := 0
    pBitmap := 0
    try {
        hdc := DllCall("user32\\GetDC", "Ptr", 0, "Ptr")
        if !hdc
            throw Error("screenshot failed")
        mdc := DllCall("gdi32\\CreateCompatibleDC", "Ptr", hdc, "Ptr")
        if !mdc
            throw Error("screenshot failed")
        hbm := DllCall("gdi32\\CreateCompatibleBitmap", "Ptr", hdc, "Int", w, "Int", h, "Ptr")
        if !hbm
            throw Error("screenshot failed")
        old := DllCall("gdi32\\SelectObject", "Ptr", mdc, "Ptr", hbm, "Ptr")
        if !DllCall("gdi32\\BitBlt", "Ptr", mdc, "Int", 0, "Int", 0, "Int", w, "Int", h, "Ptr", hdc, "Int", x, "Int", y, "UInt", 0x00CC0020, "Int")
            throw Error("screenshot failed")
        status := DllCall("gdiplus\\GdipCreateBitmapFromHBITMAP", "Ptr", hbm, "Ptr", 0, "Ptr*", &pBitmap, "Int")
        if (status != 0)
            throw Error("screenshot failed")
        clsid := Buffer(16, 0)
        if DllCall("ole32\\CLSIDFromString", "WStr", "{557CF406-1A04-11D3-9A73-0000F81EF32E}", "Ptr", clsid, "Int")
            throw Error("screenshot failed")
        status := DllCall("gdiplus\\GdipSaveImageToFile", "Ptr", pBitmap, "WStr", filePath, "Ptr", clsid, "Ptr", 0, "Int")
        if (status != 0)
            throw Error("screenshot failed")
    } finally {
        if pBitmap
            DllCall("gdiplus\\GdipDisposeImage", "Ptr", pBitmap)
        if old
            DllCall("gdi32\\SelectObject", "Ptr", mdc, "Ptr", old)
        if hbm
            DllCall("gdi32\\DeleteObject", "Ptr", hbm)
        if mdc
            DllCall("gdi32\\DeleteDC", "Ptr", mdc)
        if hdc
            DllCall("user32\\ReleaseDC", "Ptr", 0, "Ptr", hdc)
        DllCall("gdiplus\\GdiplusShutdown", "Ptr", token)
    }
}`;
