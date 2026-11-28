param([Parameter(Mandatory=$true)][uint32]$OwnedProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NabbitSettingsRead {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc,IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd,StringBuilder title,int limit);
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr Style(IntPtr hwnd,int index);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd,uint attr,out int value,uint size);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeoutW(IntPtr hwnd,uint msg,UIntPtr wp,IntPtr lp,uint flags,uint timeout,out UIntPtr result);
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] public struct MinMax { public Point reserved,maxSize,maxPosition,minTrack,maxTrack; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
  public static IntPtr Find(uint pid) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((hwnd,data)=>{ uint owner;GetWindowThreadProcessId(hwnd,out owner);if(owner!=pid)return true;var title=new StringBuilder(256);GetWindowTextW(hwnd,title,256);if(title.ToString()=="Nabbit settings"){found=hwnd;return false;}return true;},IntPtr.Zero);
    return found;
  }
  public static MinMax Minimum(IntPtr hwnd) {
    var data=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(MinMax)));
    try { Marshal.StructureToPtr(new MinMax(),data,false);UIntPtr result;if(SendMessageTimeoutW(hwnd,0x24,UIntPtr.Zero,data,2,2000,out result)==IntPtr.Zero)throw new Exception("Owned min/max query failed");return (MinMax)Marshal.PtrToStructure(data,typeof(MinMax)); }
    finally { Marshal.FreeHGlobal(data); }
  }
}
'@
$settingsHwnd = [NabbitSettingsRead]::Find($OwnedProcessId)
if ($settingsHwnd -eq [IntPtr]::Zero) { throw 'Owned settings window was not found' }
$minimum = [NabbitSettingsRead]::Minimum($settingsHwnd)
$rect = New-Object NabbitSettingsRead+Rect
[void][NabbitSettingsRead]::GetClientRect($settingsHwnd,[ref]$rect)
$backdrop = 0; $dark = 0; [uint32]$foregroundOwner = 0
$backdropResult = [NabbitSettingsRead]::DwmGetWindowAttribute($settingsHwnd,38,[ref]$backdrop,4)
$darkResult = [NabbitSettingsRead]::DwmGetWindowAttribute($settingsHwnd,20,[ref]$dark,4)
[void][NabbitSettingsRead]::GetWindowThreadProcessId([NabbitSettingsRead]::GetForegroundWindow(),[ref]$foregroundOwner)
[ordered]@{
  ownedProcessId=$OwnedProcessId; hwnd=$settingsHwnd.ToInt64(); visible=[NabbitSettingsRead]::IsWindowVisible($settingsHwnd)
  style=([NabbitSettingsRead]::Style($settingsHwnd,-16).ToInt64() -band 0xffffffffL)
  exStyle=([NabbitSettingsRead]::Style($settingsHwnd,-20).ToInt64() -band 0xffffffffL)
  dpi=[NabbitSettingsRead]::GetDpiForWindow($settingsHwnd)
  clientWidth=$rect.right-$rect.left; clientHeight=$rect.bottom-$rect.top
  minimumWidth=$minimum.minTrack.x; minimumHeight=$minimum.minTrack.y
  backdrop=$backdrop; backdropHresult=$backdropResult; darkCaption=$dark; darkHresult=$darkResult
  foregroundProcessId=$foregroundOwner
  osBuild=[int](Get-CimInstance Win32_OperatingSystem).BuildNumber
} | ConvertTo-Json -Compress
