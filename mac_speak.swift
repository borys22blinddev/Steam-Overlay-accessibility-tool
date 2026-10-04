// macOS speech helper for soa_daemon.py. Reads one JSON command per line from
// stdin: {"t":"say","text":"...","interrupt":true} or {"t":"stop"}.
//
// Usage: mac_speak [-Rate n] [-Voice name] [-Language code] [-Mute] [-Detect]
//
// Speech follows System Settings > Accessibility > Read & Speak: every message
// is spoken with the voice, rate and volume chosen there for its language.
// That is the system language, unless "Detect languages" is switched on; then
// the language of each message is recognised. Changes made in System Settings
// apply while we run. -Rate, -Voice and -Language override those settings.
import AVFoundation
import Foundation
import NaturalLanguage

var rateArg: Float?      // 0..1, AVSpeechUtterance scale
var voiceArg = ""
var languageArg = ""
var mute = false         // for testing: prints what would be spoken, with volume 0
var forceDetect = false  // for testing: detect languages whatever the system setting

var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    switch a {
    case "-Rate": if let v = args.next(), let n = Float(v) { rateArg = min(1, max(0, 0.5 + n / 200)) }  // -100..100
    case "-Voice": voiceArg = args.next() ?? ""
    case "-Language": languageArg = args.next() ?? ""
    case "-Mute": mute = true
    case "-Detect": forceDetect = true
    default: break
    }
}

let ACCESSIBILITY = "com.apple.Accessibility"
let UNIVERSAL_ACCESS = "com.apple.universalaccess"
let VOICE_PREFS = "com.apple.speech.voice.prefs"

func pref(_ key: String, _ domain: String) -> Any? {
    return CFPreferencesCopyAppValue(key as CFString, domain as CFString)
}

func base(_ code: String) -> String {
    return String(code.lowercased().prefix { $0 != "-" && $0 != "_" })
}

func defaultVoice(_ language: String) -> AVSpeechSynthesisVoice? {
    return AVSpeechSynthesisVoice(language: language)
        ?? AVSpeechSynthesisVoice.speechVoices().first { base($0.language) == base(language) }
}

struct Selection { var voice: AVSpeechSynthesisVoice?; var rate: Float?; var volume: Float? }

var selections: [String: Selection] = [:]  // language -> what Read & Speak has for it
var systemLanguage = "en"
var detect = false
var refreshedAt = Date.distantPast

let voiceOverride: AVSpeechSynthesisVoice? = {
    if voiceArg.isEmpty { return nil }
    let wanted = voiceArg.lowercased()
    let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.name.lowercased().contains(wanted) || $0.identifier.lowercased().contains(wanted) }
    return voices.first { languageArg.isEmpty || base($0.language) == base(languageArg) } ?? voices.first
}()

func refresh() {
    if Date().timeIntervalSince(refreshedAt) < 1 { return }
    refreshedAt = Date()
    for domain in [ACCESSIBILITY, UNIVERSAL_ACCESS, VOICE_PREFS] { CFPreferencesAppSynchronize(domain as CFString) }

    var sel: [String: Selection] = [:]
    // A flat list: language, selection, language, selection...
    let list = pref("SpokenContentDefaultVoiceSelectionsByLanguage", ACCESSIBILITY) as? [Any] ?? []
    for i in stride(from: 0, to: list.count - 1, by: 2) {
        guard let language = list[i] as? String, let d = list[i + 1] as? [String: Any] else { continue }
        sel[language] = Selection(voice: (d["voiceId"] as? String).flatMap { AVSpeechSynthesisVoice(identifier: $0) },
                                  rate: (d["rate"] as? NSNumber)?.floatValue,
                                  volume: (d["volume"] as? NSNumber)?.floatValue)
    }
    // The older per-language voice list, for a language without a selection above.
    for (language, id) in pref("spokenContentPreferredVoiceForLanguage", UNIVERSAL_ACCESS) as? [String: String] ?? [:] where sel[language]?.voice == nil {
        var s = sel[language] ?? Selection()
        s.voice = AVSpeechSynthesisVoice(identifier: id)
        sel[language] = s
    }
    selections = sel

    if !languageArg.isEmpty { systemLanguage = languageArg }
    else if let l = pref("SystemTTSLanguage", VOICE_PREFS) as? String, !l.isEmpty { systemLanguage = l }
    else { systemLanguage = Locale.preferredLanguages.first ?? "en" }

    let on = (pref("detectLanguagesEnabled", UNIVERSAL_ACCESS) as? NSNumber)?.boolValue ?? false
    detect = languageArg.isEmpty && voiceOverride == nil && (on || forceDetect)
}

// The language whose voice, rate and volume a message uses.
func language(of text: String) -> String {
    if !detect || text.count < 12 { return systemLanguage }
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    guard let (language, confidence) = recognizer.languageHypotheses(withMaximum: 1).first, confidence >= 0.8 else { return systemLanguage }
    return language.rawValue
}

let synth = AVSpeechSynthesizer()

func say(_ text: String, interrupt: Bool) {
    if interrupt { synth.stopSpeaking(at: .immediate) }
    if text.isEmpty { return }
    refresh()
    let lang = language(of: text)
    let sel = selections[lang] ?? selections[base(lang)]
    let u = AVSpeechUtterance(string: text)
    u.voice = voiceOverride ?? sel?.voice ?? defaultVoice(lang) ?? defaultVoice(systemLanguage)
    u.rate = rateArg ?? sel?.rate ?? AVSpeechUtteranceDefaultSpeechRate
    u.volume = mute ? 0 : sel?.volume ?? 1
    if mute {
        let line = "[\(u.voice?.name ?? "?") \(lang) rate \(u.rate) vol \(sel?.volume ?? 1)\(interrupt ? " interrupt" : "")] \(text)\n"
        FileHandle.standardError.write(line.data(using: .utf8)!)
    }
    synth.speak(u)
}

Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async {
            if msg["t"] as? String == "say" {
                say(msg["text"] as? String ?? "", interrupt: msg["interrupt"] as? Bool ?? true)
            } else if msg["t"] as? String == "stop" {
                synth.stopSpeaking(at: .immediate)
            }
        }
    }
    DispatchQueue.main.async { exit(0) }  // the daemon is gone
}

RunLoop.main.run()
