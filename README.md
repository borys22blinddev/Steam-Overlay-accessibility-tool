# Steam Overlay Access

Dostępność nakładki Steam (Shift+Tab w grze) dla osób niewidomych na Linuksie,
Windowsie i macOS. Bez OCR: nakładka to strona WWW renderowana przez `steamwebhelper`
(Chromium/CEF), więc mod czyta ją wprost z jej DOM i mówi przez speech-dispatcher
(Linux), przez NVDA lub SAPI 5 (Windows) albo głosem systemowym (macOS).

## Jak to działa

- Steam uruchomiony z plikiem `.cef-enable-remote-debugging` wystawia protokół
  DevTools na `127.0.0.1:8080`.
- `soa_daemon.py` łączy się z nim i wstrzykuje `agent.js` do kontekstu
  `SharedJSContext` (do niego należą wszystkie okna nakładki) oraz do stron
  otwartych w przeglądarce nakładki (poradniki, dyskusje, sklep).
- Agent dodaje wirtualny kursor i obsługę klawiatury, a teksty do wypowiedzenia
  odsyła demonowi. Proces gry nie jest w żaden sposób dotykany.

## Instalacja

Pobierz jeden plik z zakładki
[Releases](https://github.com/borys22blinddev/Steam-Overlay-accessibility-tool/releases)
i uruchom go. Python nie jest potrzebny.

- **Windows:** `steam-overlay-access.exe` – dwuklik. Windows SmartScreen może
  ostrzec przed nieznanym wydawcą: „Więcej informacji” → „Uruchom mimo to”.
- **Linux:** `steam-overlay-access-linux`:

      chmod +x steam-overlay-access-linux && ./steam-overlay-access-linux

- **macOS** (Apple Silicon): `steam-overlay-access-mac`, w Terminalu, w katalogu
  z pobranym plikiem (pierwsze polecenie zdejmuje kwarantannę, którą przeglądarka
  nakłada na pobrane pliki):

      xattr -d com.apple.quarantine steam-overlay-access-mac
      chmod +x steam-overlay-access-mac && ./steam-overlay-access-mac

Program kopiuje się do katalogu użytkownika, włącza port debugowania Steama,
dopisuje się do autostartu (Windows: rejestr `HKCU\...\Run`; Linux: usługa
użytkownika systemd, a bez systemd `~/.config/autostart`; macOS: agent launchd
w `~/Library/LaunchAgents`) i od razu startuje.
Potem jednorazowo zrestartuj Steama. Pobrany plik można skasować.

Aktualizacja: pobierz nowy plik i uruchom go. Usunięcie: na Windowsie uruchom
plik ponownie i wybierz „No” (Nie); na Linuksie `./steam-overlay-access-linux --uninstall`,
na macOS `./steam-overlay-access-mac --uninstall`.

Na Linuksie do mowy potrzebny jest speech-dispatcher (ten sam, którego używa Orca).

## Mowa na macOS

Mod mówi syntezatorem systemowym i trzyma się ustawień z Ustawienia systemowe →
Dostępność → Czytaj i mów: używa wybranego tam głosu, tempa i głośności. Gdy
włączone jest tam wykrywanie języków, każda wypowiedź jest czytana głosem
ustawionym dla jej języka (np. angielskie nazwy przycisków głosem angielskim).
Zmiany w ustawieniach działają od razu, bez restartu. VoiceOver nie musi być
uruchomiony.

Mac nie ma klawisza Menu: menu kontekstowe otwiera Shift+F10. Na klawiaturze
laptopa Home / End / Page Up / Page Down to Fn + strzałki, a klawisze F1–F6
mogą wymagać Fn, zależnie od ustawień klawiatury.

## Uruchamianie ze źródeł (macOS)

Wymagane: Python 3 z modułem `websockets` i narzędzia wiersza poleceń Xcode.

    swiftc -O mac_speak.swift -o mac_speak
    touch ~/Library/Application\ Support/Steam/.cef-enable-remote-debugging
    touch ~/Library/Application\ Support/Steam/Steam.AppBundle/Steam/Contents/MacOS/.cef-enable-remote-debugging
    ./soa_daemon.py -v

Potem jednorazowo zrestartuj Steama.

## Uruchamianie ze źródeł (Linux)

    ./install.sh

Potem jednorazowo zrestartuj Steama. Wymagane: `python3-websockets`,
`python3-speechd` (lub samo `spd-say`). Usunięcie: `./uninstall.sh`.

Ręczne uruchomienie z podglądem tego, co jest mówione: `./soa_daemon.py -v`.

## Uruchamianie ze źródeł (Windows)

Wymagany Python 3 z python.org. Uruchom `install.bat` (dwuklik), potem
jednorazowo zrestartuj Steama. Instalator sam doinstaluje moduł `websockets`,
włączy port debugowania Steama i doda skrót do Autostartu, więc demon rusza
przy każdym logowaniu. Usunięcie: `uninstall.bat`.

Mowa:

- Domyślnie SAPI 5, czyli głos ustawiony w systemie (Panel sterowania → Mowa).
- Żeby mod mówił przez NVDA, skopiuj obok `soa_daemon.py` (albo obok zainstalowanego
  `%LOCALAPPDATA%\steam-overlay-access\steam-overlay-access.exe`) plik
  `nvdaControllerClient.dll` w wersji zgodnej z Pythonem (zwykle 64-bitowej);
  jest w paczce „controller client" z nvaccess.org. Gdy NVDA nie działa, mod
  wraca do SAPI.

Ręczne uruchomienie z podglądem: `python soa_daemon.py -v`.

## Klawisze (gdy nakładka jest otwarta)

| Klawisz | Działanie |
| --- | --- |
| Strzałka w dół / w górę | następny / poprzedni element |
| Strzałka w prawo / w lewo, Tab | następna / poprzednia kontrolka (na suwaku: zmiana wartości) |
| H / Shift+H | następny / poprzedni nagłówek |
| Home / End | pierwszy / ostatni element |
| Page Down / Page Up | o 10 elementów |
| Enter, spacja | aktywuj (pole edycji: wejdź do edycji) |
| Klawisz Menu, Shift+F10 | menu kontekstowe elementu |
| F6 / Shift+F6 | następne / poprzednie okno nakładki |
| Backspace | zamknij bieżące okno lub menu |
| F1 | pomoc |
| F2 | gdzie jestem |
| F3 | czytaj od bieżącego miejsca |
| Ctrl | przerwij mowę |
| Tab w polu edycji | wyjdź z pola |
| Shift+Tab, Escape | zamknij nakładkę (to robi sam Steam) |

### Tryb Big Picture

W trybie Big Picture nakładka to interfejs Steama dla kontrolera (menu główne
i menu szybkiego dostępu). Tam nawigacją zajmuje się sam Steam – strzałkami
albo kontrolerem – a mod tylko wypowiada element, który dostał fokus, oraz
zmiany jego stanu (przełącznik, suwak).

| Klawisz | Działanie |
| --- | --- |
| Strzałki / kontroler | poruszanie się (robi to Steam) |
| Enter / przycisk A | aktywuj |
| Escape / przycisk B | wstecz |
| F1 | pomoc |
| F2 | gdzie jestem |
| F3 | czytaj od bieżącego miejsca |
| Ctrl | przerwij mowę |

Dodatkowo czytane są: dymki powiadomień Steama (w grze i na pulpicie),
nowe wiadomości czatu przy otwartej nakładce oraz wpisywane znaki.

Własne komunikaty moda (nazwy kontrolek, pomoc) są w języku interfejsu Steama:
po polsku, gdy Steam jest po polsku, a w pozostałych językach po angielsku.

Okienka dymków na pulpicie są ukrywane przed systemowym czytnikiem ekranu
(Orca czytała ich techniczną nazwę, np. `notificationtoasts_10016_desktop`);
treść dymka wypowiada sam mod.

## Konfiguracja

Opcjonalny plik `~/.config/steam-overlay-access/config.json`:

    {
      "echo": true,        // echo wpisywanych znaków
      "toasts": true,      // czytanie dymków powiadomień
      "chat": true,        // czytanie przychodzących wiadomości czatu
      "rate": null,        // tempo mowy -100..100
      "voice": null,       // głos (Windows, macOS: fragment nazwy głosu, np. "Paulina", "Zosia")
      "module": null,      // moduł speech-dispatchera (tylko Linux)
      "language": null,    // np. "en", jeśli Steam jest po angielsku, a syntezator po polsku
      "screenreader": true, // Windows: mów przez NVDA, gdy jest uruchomiony
      "port": 8080
    }

(Komentarze powyżej są tylko opisem; w prawdziwym pliku JSON ich nie wpisuj.)
Na Windowsie plik leży w `%APPDATA%\steam-overlay-access\config.json`, a
ustawienia `rate`, `voice` i `language` dotyczą tylko SAPI. Na macOS te trzy
ustawienia zastępują to, co wybrano w „Czytaj i mów”; bez nich mod bierze
wszystko z ustawień systemowych.
Po zmianie: `systemctl --user restart steam-overlay-access` (Linux) albo
ponownie uruchom instalator (Windows, macOS).

## Budowanie plików do wydania

`./build.sh` (wymaga `pip install pyinstaller websockets`) buduje do `dist/`
plik dla systemu, na którym jest uruchomiony. Na GitHubie robi to
`.github/workflows/release.yml`: wypchnięcie taga `v*` buduje pliki dla
wszystkich trzech systemów i dołącza je do wydania.

## Uwagi

- Port debugowania słucha tylko na localhost, ale każdy lokalny program może
  przez niego sterować Steamem.
- Aktualizacje Steama mogą zmienić wewnętrzne nazwy, z których mod korzysta
  (`g_PopupManager`, `FocusNavController`, klasy ikon). Sama nawigacja po DOM jest od nich niezależna.
