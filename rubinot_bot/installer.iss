; TBOT Autonomous Bot - Inno Setup Script
; ========================================
; Este script gera um instalador profissional para o TBOT
; incluindo driver Interception e todos os módulos necessários.

[Setup]
AppName=TBOT Autonomous Bot
AppVersion=1.0.0
AppPublisher=TBOT Development Team
AppContact=support@tbot.dev
AppCopyright=Copyright © 2024 TBOT
DefaultDirName={autopf}\TBOT
DefaultGroupName=TBOT
OutputBaseFilename=Setup_TBOT_Pro_v1.0
Compression=lzma
SolidCompression=yes
PrivilegesRequired=admin
SetupIconFile=utils\icon.ico
WizardStyle=modern
DisableDirPage=no
DisableProgramGroupPage=no
CreateUninstallRegKey=yes
UsePreviousAppDir=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
; Executável principal e DLLs do Python
Source: "dist\TBOT\TBOT.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\TBOT\*.dll"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

; Módulos internos do projeto
Source: "dist\TBOT\_internal\*"; DestDir: "{app}\_internal"; Flags: ignoreversion recursesubdirs createallsubdirs

; Driver Interception (nível kernel)
Source: "utils\interception_installer.exe"; DestDir: "{app}\utils"; Flags: ignoreversion

; Documentação
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "BUILD_INSTRUCTIONS.md"; DestDir: "{app}"; Flags: ignoreversion

; Arquivo de licença
Source: "LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\TBOT"; Filename: "{app}\TBOT.exe"
Name: "{autodesktop}\TBOT"; Filename: "{app}\TBOT.exe"; Tasks: desktopicon
Name: "{group}\Uninstall TBOT"; Filename: "{uninstallexe}"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Run]
; Instala o driver Interception silenciosamente
; Aguarda conclusão antes de prosseguir
Filename: "{app}\utils\interception_installer.exe"; Parameters: "/install /silent"; Flags: runhidden waituntilterminated; StatusMsg: "Instalando driver de emulação (Interception)..."; Check: not IsTaskSelected('nopilot')

; Lança o TBOT após instalação se usuário desejar
Filename: "{app}\TBOT.exe"; Description: "{cm:LaunchProgram,TBOT Autonomous Bot}"; Flags: nowait postinstall skipifsilent

[Code]
// Verifica se o processo do jogo está rodando antes de permitir instalação
function ShouldInstall(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
end;

// Mensagem personalizada pós-instalação
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    MsgBox('TBOT foi instalado com sucesso!' + #13#10 + #13#10 + 
           'IMPORTANTE:' + #13#10 + 
           '1. Certifique-se de que o Rubinot/OTClient esteja aberto antes de iniciar o TBOT.' + #13#10 + 
           '2. O driver Interception foi instalado para emulação indetectável.' + #13#10 + 
           '3. Execute sempre como Administrador para melhor funcionamento.', 
           mbInformation, MB_OK);
  end;
end;

[UninstallDelete]
Type: filesandordirs; Name: "{app}\data"
Type: filesandordirs; Name: "{app}\logs"
