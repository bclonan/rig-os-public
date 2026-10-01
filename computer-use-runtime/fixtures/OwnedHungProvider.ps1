param([Parameter(Mandatory=$true)][string]$ArmPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml, UIAutomationProvider, UIAutomationTypes
Add-Type -ReferencedAssemblies PresentationFramework, PresentationCore, WindowsBase, System.Xaml, UIAutomationProvider, UIAutomationTypes -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation.Peers;
public class OwnedSlowButton : Button {
  public static string ArmPath;
  protected override AutomationPeer OnCreateAutomationPeer() {
    return new OwnedSlowPeer(this);
  }
}
public class OwnedSlowPeer : ButtonAutomationPeer {
  public OwnedSlowPeer(OwnedSlowButton owner) : base(owner) {}
  protected override string GetNameCore() {
    if (File.Exists(OwnedSlowButton.ArmPath)) {
      File.WriteAllText(OwnedSlowButton.ArmPath + ".entered", DateTime.UtcNow.ToString("O"));
      Thread.Sleep(30000);
    }
    return "Owned delayed UIA provider";
  }
}
'@
[OwnedSlowButton]::ArmPath = $ArmPath
$window = New-Object Windows.Window
$window.Title = 'Computer use owned UIA deadline fixture'
$window.Width = 420
$window.Height = 180
$button = New-Object OwnedSlowButton
$button.Content = 'Read-only deadline fixture'
$window.Content = $button
$window.Add_ContentRendered({
  $interop = New-Object Windows.Interop.WindowInteropHelper($window)
  [Console]::Out.WriteLine((@{pid=$PID;handle=$interop.Handle.ToInt64()} | ConvertTo-Json -Compress))
})
[void]$window.ShowDialog()
