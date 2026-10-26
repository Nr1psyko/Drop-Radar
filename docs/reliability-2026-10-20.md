# Drop-Radar: uitvoeringsbetrouwbaarheid, 20 oktober 2026

## Bevinding

De grote gaten ontstaan vóór het aanmaken van de zichtbare Actions-runs. De
beschikbare gegevens wijzen op onregelmatige afhandeling van geplande triggers
door GitHub, maar bewijzen niet welke interne scheduler-oorzaak elk uur heeft
gemist. Er is geen bewijs van een urenlang draaiende scanner of een foutieve
vijf-/zesuurscron.

Onderzocht: de laatste 100 repository-runs (nummers 813–912), van 28 september
17:33:59 tot 20 oktober 11:19:45 UTC; alle 100 zijn `schedule`, `success`, eerste
poging. De runnummers zijn aaneengesloten. De compacte API-snapshot staat in
[run-history-2026-10-20.csv](run-history-2026-10-20.csv). Bron:
`GET /repos/Nr1psyko/Drop-Radar/actions/runs?per_page=100`.

## Planning tegenover uitvoering

`0 * * * *` vraagt elk uur op minuut nul een run aan. Op 20 oktober liggen tussen
00:00 en 11:19 twaalf geplande uurmomenten, tegenover drie geregistreerde runs.
De API geeft geen oorspronkelijk bedoeld cronmoment per run. Daarom kan een run
niet betrouwbaar aan één specifiek gemist uur worden gekoppeld; minuten na het
laatste hele uur zijn **geen bewezen totale schedulervertraging**.

| Run | Aangemaakt/start run UTC | Start runner UTC | Scan-stap UTC | Job klaar UTC | Afstand vorige run |
|---|---|---|---|---|---|
| [910](https://github.com/Nr1psyko/Drop-Radar/actions/runs/39346406930) | 00:13:57 | 00:14:00 | 00:14:07–00:14:08 | 00:14:11 | 3:15:54 |
| [911](https://github.com/Nr1psyko/Drop-Radar/actions/runs/39377035999) | 05:50:23 | 05:50:25 | 05:50:35–05:50:36 | 05:50:40 | 5:36:26 |
| [912](https://github.com/Nr1psyko/Drop-Radar/actions/runs/39414162128) | 11:19:45 | 11:19:48 | 11:19:54–11:19:55 | 11:19:58 | 5:29:22 |

De voorgaande run was 19 oktober 20:58:03 UTC. De logboeken van de drie runs
melden respectievelijk 311, 310 en 314 gescande items; 0, 0 en 1 nieuwe kandidaat.
Alle drie schreven 600 IDs terug en pushten hun state-commit succesvol. In deze
drie logs staan geen `source failed`- of `push failed`-regels. De laatste state
is `2026-10-20T11:19:55.517Z`, commit
`5afd3c9f39f300f259ca711072f23efcb47da91e`.

Over de zeven volledige UTC-dagen 13–19 oktober: **37 runs / 168 uurmomenten
(22,0%)**, per dag 4, 5, 5, 6, 6, 7 en 4. Dit is een vergelijking van aantallen,
geen exact percentage bewezen door GitHub weggegooide events. Over de 99
tussenpozen in de snapshot: minimum 2:06:51, mediaan 5:19:14, maximum 10:43:57.

## Oorzaken en grenzen van het bewijs

- De workflow is sinds de introductie op 21 juni ongewijzigd:
  [0caf0f6](https://github.com/Nr1psyko/Drop-Radar/commit/0caf0f6be29b1679474b207de5b1252ea170e29b).
  Cron staat op `0 * * * *`, uitsluitend `schedule` en `workflow_dispatch`;
  geen voorwaarden, padenfilters, wachttijd of omgevingsgoedkeuringen.
- `main` is de default branch en bevat de workflow. Er waren geen open PRs voor
  dezelfde reparatie. Recente runs en state-commits tonen activiteit; een
  blijvende automatische uitschakeling wegens 60 dagen inactiviteit verklaart
  deze herhaalde succesvolle runs niet.
- `created_at` en `run_started_at` zijn gelijk voor alle 100 runs. De drie
  onderzochte jobs beginnen 2–3 seconden later. Hun uitvoeringsduur verklaart
  de urenlange gaten niet. Bij de extra steekproef op 19 oktober 15:28 begint
  de job na 7 seconden en duurt hij 13 seconden; de latere `updated_at` is geen
  bewijs van acht minuten scantijd.
- `concurrency: drop-radar` en `cancel-in-progress: false` voorkomen parallelle
  scans. Geen cancellations in de snapshot. Een drukke concurrency-wachtrij
  wordt dus niet door deze runs ondersteund als verklaring.
- `[skip ci]` op state-commits geldt volgens GitHub voor `push`/`pull_request`,
  niet voor `schedule`; bovendien zijn de geplande runs op zulke commits zichtbaar.
- GitHub documenteert vertraging en wegvallen van geplande jobs bij hoge
  belasting, specifiek rond het hele uur. Dit is een aannemelijke verklaring
  die bij het waargenomen patroon past, geen bevestigd intern incidentrapport.
  Accountbrede scheduler-/quotadiagnostiek en interne triggerlogs zijn hier niet
  beschikbaar. De workflow-metadata-endpoint was door de connector niet ondersteund;
  er wordt geen claim gedaan over het actuele `state`-veld van die endpoint.

Bronnen:
- [GitHub schedule-documentatie](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GitHub skip-instructies](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)

## Kleine wijziging

| Onderdeel | Oud | Nieuw |
|---|---|---|
| Cron | `0 * * * *` | `17 * * * *` (UTC) |
| Frequentie | 1 poging per uur | 1 poging per uur |
| Checkout | Event-ref/SHA | Actuele `main` na concurrency-lock |
| Handmatig vanaf andere branch | Mogelijk met eigen verouderde state | Productiescan overgeslagen |
| Deduplicatie-state ontbreekt/beschadigd | Scanner kan stil reseeden | Vooraf stoppen; eerst herstellen |
| Pauzes | Geen expliciete registratie | Waarschuwing bij >90 minuten; geschatte gemiste intervallen |
| Laatste uitvoering | Alleen `state.updated` | Apart `radar-health.json` met tijd, runlink en vorige checkpoint |
| State opslaan | Eén pushpoging | Maximaal drie persist-pogingen met fetch/rebase; scan wordt niet herhaald |
| Pushconflict | Run faalt; lokale state verdwijnt | Run faalt; state van vóór rebase blijft als herstelartifact 7 dagen beschikbaar |
| Scanlogica, meldingen, score, IDs | Bestaand | `radar.js` bytegelijk; `state.json` niet aangepast door deze patch |

Het nieuwe healthbestand wordt pas door een echte succesvolle productie-uitvoering
aangemaakt en samen met de deduplicatie-state in één commit gepusht. Geen verzonnen
succesregistratie vooraf. Een run geldt hier als succesvol wanneer de scanner
exitcode nul heeft en verse state heeft geschreven; de bestaande afhandeling kan
bron-/Pushover-fouten opvangen. Dit is geen bewijs van volledige brondekking.

Een te lange pauze wordt bij de **volgende** run zichtbaar in de Actions-waarschuwing
en samenvatting. Dit mechanisme kan een geheel stilgevallen scheduler niet zelf
wekken en verstuurt geen extra Pushover-meldingen. Voor gegarandeerde monitoring
tijdens stilstand is een onafhankelijke scheduler/heartbeat nodig; die is niet
toegevoegd in deze beperkte patch.

## Validatie en resterende risico's

- Zeven offline Node-tests: normale cadans en 90-minutengrens, waargenomen lange
  pauze, ontbrekende/ongeldige/toekomstige tijd, legacy-state, beschadigde IDs,
  geen succes vóór verse state, herhaalde echte scanner zonder dubbele push,
  overflow-deduplicatie, bestaande retrysemantiek bij mislukte meldingen.
- Scanner draait in de tests met volledig gemockte API en opslag. Er zijn geen
  productiemeldingen verzonden. PR-workflow controleert op Node 20 zonder secrets.
- YAML en ingebedde shell worden lokaal gecontroleerd; `git diff --check` schoon.
- De werkelijke persist-shell is daarnaast met geïsoleerde lokale Git-repositories
  getest: onafhankelijke README-update wordt behouden en state wordt opgeslagen;
  conflicterende state faalt zonder remote-overschrijving; permanent geweigerde
  push stopt na precies drie pogingen. In alle drie blijft de herstelkopie intact.
- De zeven Node-tests zijn lokaal geslaagd op Node 24.19.0; de toegevoegde
  PR-workflow is de controle op de gebruikte productieversie Node 20.
- De bestaande `seen`-limiet van 600 blijft bestaan: oude verwijderde IDs kunnen
  later opnieuw verschijnen. De patch garandeert geen eeuwige deduplicatie.
- Tussen een geaccepteerde Pushover-melding en duurzaam opgeslagen state blijft
  een crash-/netwerkvenster bestaan. Bij persist-falen eerst herstelartifact en
  actuele main vergelijken vóór herstart; blind herstarten kan meldingen herhalen.
- Conflict met een andere schrijver van state wordt bewust niet automatisch
  opgelost: geen overschrijven of wissen van onbekende IDs. Gewone code-/docupdates
  kunnen via rebase wel worden meegenomen.

**Aantoonbare verbetering:** geregistreerde lange pauzes, expliciet gekoppeld
succescheckpoint, actuele state voor opeenvolgende runs, en herstelbare state bij
persist-problemen. **Nog niet aangetoond:** hogere werkelijke scanfrequentie door
minuut 17. Dat vereist observatie na merge; een feature-branch draait geen cron.

Na merge: vergelijk 48 uur aan runaanmaak, jobstart en health-gaten met deze
baseline. Een normale cadans heeft ongeveer 48 runs per 48 uur, met GitHub-jitter.
Een afname van lange pauzes kan worden gemeten; exacte uurlijkse uitvoering blijft
zonder onafhankelijke scheduler onbewezen en niet gegarandeerd.

## Nut voor Wietse

Deze radar doorzoekt openbare GitHub-topics en Hugging Face-modelcategorieën voor
muziek/audio, stem, beeld, video, bewerking, 3D/avatars en world models. Hij leest
geen privébestanden op jouw pc. Hij is nuttig als aanvullende automatische tipgever
voor je AI-/muziek-/videoprojecten. Hij vervangt geen brede internetresearch:
nieuwssites, commerciële productaankondigingen en veel modellen buiten de gekozen
topics kunnen ontbreken. GitHub-resultaten zijn bovendien op sterren gesorteerd
binnen een venster van recente updates; een ontdekking is niet noodzakelijk een
net uitgebrachte repository. De bestaande score is vooral gericht op technische
bruikbaarheid/commerciële inzetbaarheid, niet bewezen geschiktheid voor jouw RTX 5090.
