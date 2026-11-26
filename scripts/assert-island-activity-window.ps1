param([long]$NativeHwnd,[int]$OwnerProcessId,[ValidateRange(0,1)][int]$ExpectedInteractive=0)
$Interactive=($ExpectedInteractive -eq 1)
$ErrorActionPreference='Stop'
if($NativeHwnd -le 0 -or $OwnerProcessId -le 0){throw 'Expected owned HWND and PID'}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ActivityWindowFlags {
  public delegate bool Callback(IntPtr hwnd,IntPtr param);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr Flags(IntPtr hwnd,int index);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint process);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr param);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int size);
  public static uint Owner(IntPtr hwnd){uint process;GetWindowThreadProcessId(hwnd,out process);return process;}
  public static IntPtr Web(int processId){IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{if(Owner(h)!=processId)return true;var text=new StringBuilder(128);GetWindowText(h,text,128);if(text.ToString()=="Nabbit island input probe"){found=h;return false;}return true;},IntPtr.Zero);return found;}
}
'@
$nativeHandle=[IntPtr]$NativeHwnd;$webHandle=[ActivityWindowFlags]::Web($OwnerProcessId)
if($webHandle -eq [IntPtr]::Zero){throw 'Owned WebView2 probe is missing'}
$values=@();foreach($handle in @($nativeHandle,$webHandle)){
  if([ActivityWindowFlags]::Owner($handle) -ne $OwnerProcessId -or -not [ActivityWindowFlags]::IsWindowVisible($handle)){throw 'Expected a shown owned window'}
  $flags=[ActivityWindowFlags]::Flags($handle,-20).ToInt64()
  if((($flags -band 0x20) -eq 0) -ne $Interactive){throw 'Actual click-through style differs from decision'}
  foreach($bit in @(0x08000000,0x8)){if(($flags -band $bit) -ne $bit){throw "Required style missing: hwnd=$handle flags=$('{0:x}' -f $flags) bit=$('{0:x}' -f $bit)"}}
  if($handle -eq $nativeHandle -and ($flags -band 0x80) -eq 0){throw 'Native host lost tool-window style'}
  $values+=@{hwnd=$handle.ToInt64();flags=$flags;shown=$true;interactive=$Interactive}
}
if([ActivityWindowFlags]::Owner([ActivityWindowFlags]::GetForegroundWindow()) -eq $OwnerProcessId){throw 'Nabbit became foreground'}
$values|ConvertTo-Json -Compress
