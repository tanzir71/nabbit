param([string]$Exe="src-tauri/target/debug/nabbit.exe")
$ErrorActionPreference="Stop"
$root=Split-Path -Parent $PSScriptRoot
$exePath=(Resolve-Path -LiteralPath (Join-Path $root $Exe)).Path
$output=Join-Path $root "progress/v2/M2"
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class NabbitIconFrame {
  public int Size; public int Id; public byte[] Png;
}
public static class NabbitIconResources {
  private delegate bool EnumName(IntPtr module,IntPtr type,IntPtr name,IntPtr param);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern IntPtr LoadLibraryExW(string name,IntPtr file,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool EnumResourceNamesW(IntPtr module,IntPtr type,EnumName callback,IntPtr param);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern IntPtr FindResourceW(IntPtr module,IntPtr name,IntPtr type);
  [DllImport("kernel32.dll")] private static extern IntPtr LoadResource(IntPtr module,IntPtr resource);
  [DllImport("kernel32.dll")] private static extern IntPtr LockResource(IntPtr resource);
  [DllImport("kernel32.dll")] private static extern uint SizeofResource(IntPtr module,IntPtr resource);
  [DllImport("kernel32.dll")] private static extern bool FreeLibrary(IntPtr module);
  [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr CreateIconFromResourceEx(byte[] bits,uint size,bool icon,uint version,int width,int height,uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
  private static byte[] Read(IntPtr module,IntPtr name,int type) {
    var info=FindResourceW(module,name,new IntPtr(type));
    if(info==IntPtr.Zero) throw new Win32Exception();
    var size=SizeofResource(module,info);
    var address=LockResource(LoadResource(module,info));
    if(address==IntPtr.Zero || size==0) throw new Win32Exception();
    var data=new byte[size]; Marshal.Copy(address,data,0,data.Length); return data;
  }
  public static NabbitIconFrame[] ReadFrames(string exe) {
    // Read resources as data; no executable code, window or process is launched.
    var module=LoadLibraryExW(exe,IntPtr.Zero,2);
    if(module==IntPtr.Zero) throw new Win32Exception();
    try {
      byte[] group=null;
      EnumName callback=(m,t,n,p)=>{group=Read(m,n,14);return false;};
      EnumResourceNamesW(module,new IntPtr(14),callback,IntPtr.Zero);
      GC.KeepAlive(callback);
      if(group==null) throw new Exception("Missing application icon group");
      var frames=new List<NabbitIconFrame>();
      for(int i=0;i<BitConverter.ToUInt16(group,4);i++) {
        int entry=6+i*14;
        int size=group[entry]==0?256:group[entry];
        int id=BitConverter.ToUInt16(group,entry+12);
        var png=Read(module,new IntPtr(id),3);
        if(png.Length!=BitConverter.ToUInt32(group,entry+8)) throw new Exception("Resource length mismatch");
        frames.Add(new NabbitIconFrame{Size=size,Id=id,Png=png});
      }
      return frames.ToArray();
    } finally {FreeLibrary(module);}
  }
}
'@
Add-Type -AssemblyName System.Drawing
$frames=[NabbitIconResources]::ReadFrames($exePath)
if(($frames.Size|Sort-Object)-join ',' -ne '16,24,32,48,64,128,256'){throw "Unexpected icon group sizes"}
$report=@()
foreach($frame in $frames) {
  $size=$frame.Size
  $resourcePath=Join-Path $output "v15-resource-$size.png"
  [IO.File]::WriteAllBytes($resourcePath,$frame.Png)
  $expected=Get-FileHash -LiteralPath (Join-Path $root "src-tauri/icons/${size}x${size}.png") -Algorithm SHA256
  $actual=Get-FileHash -LiteralPath $resourcePath -Algorithm SHA256
  if($expected.Hash -ne $actual.Hash){throw "Embedded $size icon differs from generated asset"}
  $icon=[NabbitIconResources]::CreateIconFromResourceEx($frame.Png,$frame.Png.Length,$true,0x00030000,$size,$size,0)
  if($icon -eq [IntPtr]::Zero){throw "Win32 could not decode $size icon"}
  try {
    $wrapper=[Drawing.Icon]::FromHandle($icon)
    try {
      $bitmap=$wrapper.ToBitmap()
      try {$bitmap.Save((Join-Path $output "v15-win32-icon-$size.png"),[Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose()}
    } finally {$wrapper.Dispose()}
  } finally {[void][NabbitIconResources]::DestroyIcon($icon)}
  $report+=@{size=$size;resourceId=$frame.Id;sha256=$actual.Hash.ToLowerInvariant();originalPngMatches=$true;win32Decoded=$true}
}
[IO.File]::WriteAllText((Join-Path $output "v15-icon-resources.json"),(@{executableSha256=(Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant();frames=$report;executed=$false;windowsPreferencesChanged=$false}|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
Write-Output "Passed all seven embedded app-icon PNG resources and Win32 HICON decoding."
