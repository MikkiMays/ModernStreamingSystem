---
name: windows-client-checks-on-linux
description: "Как проверить C# клиента Cord на этой машине, хотя WinUI здесь не собирается"
metadata: 
  type: reference
---

`ModernStreamingSystem.Windows` на этой машине **не собирается целиком**: `global.json` требует
SDK 10.0.400, установлен 10.0.112, а XAML-компилятор и `MakePri.exe` — бинарники под Windows.
Но отправлять C# в CI вслепую не нужно — проверяется почти всё, кроме самого XAML.

Три приёма (15.09.2026, проверены):

1. **Скопировать репозиторий в скретчпад, удалить `global.json` и `packages.lock.json`.** После
   этого `dotnet build src/Cord.Core/Cord.Core.csproj` проходит начисто — а у Cord.Core включён
   `TreatWarningsAsErrors`.
2. **Тесты запускаются прямо здесь.** `tests/Cord.Core.Tests` таргетит `net10.0-windows`, но
   это ограничение *запуска платформенных API*, не компиляции: `dotnet build` собирает, а
   `dotnet bin/Debug/net10.0-windows/Cord.Core.Tests.dll` выполняет. Падают только тесты на
   DPAPI (`ProtectedData` — «Operation is not supported on this platform»); остальные 43 из 45
   дают настоящий сигнал.
3. **`MainWindow.xaml.cs` типизируется отдельным проектом-пустышкой.** Библиотека с
   `EnableWindowsTargeting=true`, `GenerateProjectPriFile=false`, `EnableMsixTooling=false`,
   `EnableDefaultCompileItems=false`, ссылками на WindowsAppSDK/WebView2/Mvvm и `Compile Include`
   нужных файлов, плюс `Stubs.cs` с `partial class MainWindow`, где объявлены поля из XAML
   (`Root`, `TitlebarHost`, `DragRegion`, `TitlebarRow`, `PaneToggle`, `NavigationSplit`,
   `WorkspaceHost`, `WorkspaceFrame`) и пустой `InitializeComponent()`. PriGen всё равно
   падает в конце, но `csc` к этому моменту уже отработал: ошибки и предупреждения C# видны.

Форматирование CI (`dotnet format whitespace --verify-no-changes`) тоже проверяется этим
способом по каждому csproj отдельно.

Отдельная ловушка: `.gitattributes` объявляет `*.cs text eol=crlf`, и рабочее дерево здесь
действительно в CRLF. Правка файла скриптом на Python перепишет его целиком в LF — git это
нормализует и в diff не покажет, но локальный diff раздувается до всего файла. После скриптовых
правок возвращать CRLF.

Связано: [[meet-cord-system]].
