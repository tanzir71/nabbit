param([Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$OwnedProcessId)
$ErrorActionPreference='Stop'
Get-Process -Id $OwnedProcessId -ErrorAction Stop | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class NabbitOwnedWindow {
  public long hwnd;
  public string title;
  public string className;
  public bool visible;
}
public static class NabbitOwnedWindows {
  delegate bool Callback(IntPtr hwnd,IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int capacity);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder text,int capacity);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static uint ForegroundProcess() {uint pid;GetWindowThreadProcessId(GetForegroundWindow(),out pid);return pid;}
  public static NabbitOwnedWindow[] Read(uint owned) {
    var windows=new List<NabbitOwnedWindow>();
    EnumWindows((hwnd,data)=> {
      uint pid;GetWindowThreadProcessId(hwnd,out pid);
      // Do not read the title/class of any other application's window.
      if(pid!=owned)return true;
      var title=new StringBuilder(1024);var name=new StringBuilder(256);
      GetWindowText(hwnd,title,title.Capacity);GetClassName(hwnd,name,name.Capacity);
      windows.Add(new NabbitOwnedWindow {hwnd=hwnd.ToInt64(),title=title.ToString(),className=name.ToString(),visible=IsWindowVisible(hwnd)});
      return true;
    },IntPtr.Zero);
    return windows.ToArray();
  }
}
'@
[ordered]@{processId=$OwnedProcessId;foregroundProcessId=[NabbitOwnedWindows]::ForegroundProcess();windows=@([NabbitOwnedWindows]::Read($OwnedProcessId))} | ConvertTo-Json -Depth 5 -Compress
