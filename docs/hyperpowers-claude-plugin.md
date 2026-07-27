# Hyperpowers

## Rapport de choix, architecture et workflow du plugin

Version de conception : 26 juillet 2026

---

# 1. Résumé exécutif

Hyperpowers sera un plugin Claude Code de développement logiciel autonome, en anglais, fondé sur quatre composants principaux :

1. Superpowers fournit la méthode de conception, de planification et d’exécution. [https://github.com/obra/superpowers]
2. Claude Fable 5 conserve la vision produit et l’autorité finale.
3. Claude Opus 5 organise le travail, construit l’architecture et supervise les opérations.
4. Claude Sonnet 5 réalise la majorité du travail opérationnel.
5. Codex intervient comme contradicteur indépendant au cours de six revues adversariales obligatoires. [https://github.com/openai/codex-plugin-cc]

Le fonctionnement général est validé, mais une correction importante doit être apportée à l’architecture précédemment proposée :

> Fable doit centraliser l’autorité, mais pas tout le trafic opérationnel.

L’architecture optimale n’est donc plus une étoile pure dans laquelle chaque agent remonte directement à Fable. Elle devient une hiérarchie bornée à deux niveaux :

```text
Fable — direction produit et arbitrage
│
├── Opus — coordination, architecture et supervision
│   ├── Sonnet — recherche
│   ├── Sonnet — implémentation
│   ├── Sonnet — tests
│   └── Sonnet — vérification
│
└── Sonnet direct — uniquement pour certaines tâches simples et bornées
```

Claude Code permet maintenant explicitement cette profondeur de délégation. Les sous-agents peuvent lancer leurs propres sous-agents lorsque `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` est configuré, et seul le résumé du sous-agent supérieur remonte au thread principal. Ce comportement correspond précisément à l’objectif de protéger le contexte de Fable des sorties opérationnelles volumineuses.

Le principe organisationnel de Hyperpowers devient donc :

> Fable dirige. Opus orchestre. Sonnet exécute. Codex contredit. Les tests et les preuves décident.

---

# 2. Décisions définitives

| Question                        | Décision                                                  |
| ------------------------------- | --------------------------------------------------------- |
| Nature du projet                | Plugin Claude Code                                        |
| Nom                             | `hyperpowers`                                             |
| Point d’entrée                  | `/hyperpowers:feature`                                    |
| Méthode de développement        | Superpowers adapté par une surcouche                      |
| Interaction utilisateur         | Description initiale et phase de brainstorming uniquement |
| Validation du design            | Automatique                                               |
| Validation du plan              | Automatique                                               |
| Exécution                       | Automatique                                               |
| Boucle d’autonomie              | Machine à états et hooks, sans `/goal`                    |
| Modèle directeur                | Fable 5                                                   |
| Modèle coordinateur             | Opus 5                                                    |
| Modèle opérationnel             | Sonnet 5                                                  |
| Reviewer externe                | Codex, selon la philosophie d’`adversarial-review`        |
| Nombre minimal de reviews Codex | Six                                                       |
| Git                             | Lectures autorisées, mutations interdites                 |
| Worktrees                       | Interdits                                                 |
| Commits                         | Interdits                                                 |
| Advisor Claude Code             | Désactivé                                                 |
| Workflows Claude Code           | Désactivés ou rendus inaccessibles                        |
| `subagent-driven-development`   | Non utilisé                                               |
| `executing-plans`               | Utilisé                                                   |
| Niveau d’effort par défaut      | High                                                      |
| Niveau d’effort renforcé        | Xhigh selon le risque                                     |
| Niveau Max                      | Non utilisé par défaut                                    |
| Niveau Medium                   | Non utilisé par défaut                                    |
| Déclaration de réussite         | Tests, critères d’acceptation, preuves et reviews validés |
| Échec insoluble                 | État explicite `BLOCKED`                                  |

---

# 3. Analyse objective de `fable-advisor`

## 3.1 Ce que le projet apporte réellement

`fable-advisor` ne constitue pas un système complet de développement autonome. Il apporte cependant plusieurs principes extrêmement pertinents. [https://github.com/DannyMac180/fable-advisor]

Son principe économique central est de réserver les modèles coûteux au jugement et de confier le volume à des modèles moins chers :

* produire du jugement plutôt que du volume ;
* garder le contexte du modèle supérieur léger ;
* raisonner une fois, puis déléguer ;
* transmettre une spécification suffisamment complète pour qu’un agent sans contexte puisse travailler ;
* utiliser un reviewer supérieur à des frontières de décision précises.

Son agent Fable est explicitement conçu comme un conseiller en lecture seule, consulté pour les décisions architecturales importantes et pour une revue finale. Il ne doit ni écrire le code ni devenir un exécutant généraliste.

Cette philosophie correspond exactement à ta métaphore du CEO.

## 3.2 Les inspirations à reprendre

### Le modèle supérieur doit émettre des décisions, pas des pages de recherche

Fable ne doit pas :

* explorer tout le dépôt ;
* lire les logs complets ;
* lancer les suites de tests ;
* corriger directement des détails locaux ;
* relire chaque fichier modifié ;
* suivre chaque action des Sonnet.

Il doit recevoir une synthèse décisionnelle très courte.

### La délégation doit se faire par contrat

`fable-advisor` utilise un contrat de délégation en cinq parties. Hyperpowers doit reprendre ce principe et l’étendre.

Chaque paquet de travail Sonnet contiendra :

```text
1. Objectif
2. Périmètre et fichiers concernés
3. Interfaces et comportements attendus
4. Contraintes et éléments interdits
5. Méthode de vérification
6. Critères d’acceptation associés
7. Éléments explicitement hors périmètre
8. Format du rapport de retour
```

Un Sonnet ne doit jamais recevoir simplement :

```text
Implémente cette partie du plan.
```

Il doit recevoir un paquet autonome et vérifiable.

### Les échecs de modèle doivent être visibles

Le `codex-implementer` de `fable-advisor` vérifie la présence du CLI Codex et refuse tout remplacement silencieux par un autre modèle. Cette politique est excellente : une infrastructure autonome doit échouer explicitement plutôt que dégrader silencieusement sa qualité.

Hyperpowers reprendra donc le principe :

```text
Modèle demandé indisponible
→ fallback explicitement autorisé
→ événement enregistré
→ sinon état BLOCKED
```

### Le reviewer doit disposer d’un contexte propre

Le reviewer supérieur doit examiner les artefacts réels sans hériter de toutes les hypothèses accumulées pendant l’implémentation.

Hyperpowers utilisera donc :

* des agents de review frais ;
* des paquets de contexte reconstruits ;
* des preuves et chemins de fichiers ;
* aucun raisonnement interne de l’agent qui a produit le travail.

## 3.3 Ce qu’il ne faut pas reprendre

`fable-advisor` ne doit pas devenir une dépendance de Hyperpowers.

Il ne fournit pas :

* de machine à états ;
* de reprise fiable après compaction ;
* de politique Git déterministe ;
* de gestion des six reviews ;
* de ledger des tâches ;
* de circuit breaker ;
* de validation formelle des sorties ;
* de séparation entre design, plan et implémentation ;
* de mesure du ratio Fable–Opus–Sonnet.

Son orchestration repose essentiellement sur des instructions déclaratives. Cela convient à son périmètre léger, mais pas au niveau d’autonomie recherché ici.

Par ailleurs, son architecture actuelle place Opus comme architecte principal, Codex comme lane d’implémentation et Fable comme conseiller ponctuel.

Hyperpowers conservera Sonnet comme exécutant principal et Codex comme reviewer externe. Cette séparation est préférable : le même modèle externe ne doit pas être à la fois le principal producteur de code et le principal contradicteur de ce code.

## 3.4 Verdict sur `fable-advisor`

`fable-advisor` est :

* une excellente source de principes ;
* une bonne démonstration de discipline économique ;
* une inspiration directe pour les briefs et les rapports ;
* un mauvais candidat comme fondation technique de Hyperpowers.

Le projet doit être étudié, cité dans les inspirations et éventuellement utilisé comme corpus d’évaluation, mais pas imbriqué comme dépendance opérationnelle.

---

# 4. Révision de l’architecture pyramidale

## 4.1 La limite de l’étoile physique

L’architecture en étoile pure aurait été :

```text
         Fable
      /    |    \
   Opus Sonnet Sonnet
      \    |    /
         Fable
```

Cette solution permet un contrôle central, mais elle présente une contradiction avec ton objectif :

* tous les résultats transitent par Fable ;
* Fable doit dispatcher les petits travaux ;
* Fable reçoit les résumés de chaque Sonnet ;
* son contexte se remplit de décisions opérationnelles ;
* chaque transition nécessite une nouvelle inférence Fable.

Même si Fable ne lit pas les résultats complets, il devient progressivement un chef de projet opérationnel plutôt qu’un directeur produit.

## 4.2 Architecture retenue : hiérarchie bornée avec bypass

```text
                         FABLE
                Direction et autorité finale
                            │
             ┌──────────────┴──────────────┐
             │                             │
          OPUS COO               SONNET DIRECT
      Coordination générale       Tâches triviales
             │                     et très bornées
       ┌─────┼─────┐
       │     │     │
    SONNET SONNET SONNET
    recherche code   tests
```

Fable conserve :

* la conversation avec l’utilisateur ;
* la compréhension produit ;
* la direction globale ;
* le scope ;
* les non-objectifs ;
* les arbitrages irréversibles ;
* la validation automatique du design ;
* la validation finale.

Opus reçoit de Fable une mission complète, puis organise les Sonnet. Seul le rapport synthétique d’Opus remonte à Fable.

Claude Code prévoit précisément ce cas : les sous-agents imbriqués travaillent dans leurs propres contextes et seul le résumé du sous-agent de premier niveau revient au parent.

## 4.3 Profondeur maximale

Hyperpowers configurera :

```json
{
  "env": {
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "2"
  }
}
```

La profondeur maximale sera :

```text
Niveau 0 : Fable
Niveau 1 : Opus ou Sonnet direct
Niveau 2 : Sonnet lancé par Opus
```

Aucun Sonnet ne possédera l’outil `Agent`.

Aucune délégation de profondeur trois ne sera autorisée.

Cette limite évite :

* les arbres incontrôlables ;
* les doubles résumés successifs ;
* la perte de responsabilité ;
* la multiplication cachée des coûts ;
* les boucles de délégation.

## 4.4 Limitation actuelle de Claude Code

Claude Code permet de limiter les agents qu’un agent principal peut lancer avec une syntaxe comme :

```text
Agent(worker, researcher)
```

Mais cette liste de types est ignorée lorsqu’elle apparaît dans un sous-agent imbriqué. Un Opus disposant de l’outil `Agent` peut donc techniquement demander d’autres types d’agents que les Sonnet prévus.

Ce problème n’est pas critique pour la sécurité, car :

* toutes les mutations Git restent bloquées globalement ;
* les Sonnet n’ont pas accès à `Agent` ;
* le ledger détecte les agents et modèles lancés ;
* les budgets limitent les dérives ;
* l’Opus reçoit une instruction explicite de ne lancer que les agents Hyperpowers autorisés.

Le routage des modèles est une préférence économique. Il peut rester encadré par le prompt et la télémétrie. Les règles destructrices, elles, restent garanties par des hooks.

---

# 5. Répartition Fable–Opus–Sonnet

## 5.1 Fable : autorité et vision

Fable est responsable de ce qui suit :

* interprétation du besoin utilisateur ;
* participation au brainstorming ;
* choix de direction produit ;
* maintien du scope ;
* validation automatique du design ;
* arbitrage des décisions irréversibles ;
* résolution des désaccords majeurs entre Opus et Codex ;
* acceptation finale.

Fable n’est normalement pas responsable de :

* rechercher des fichiers ;
* lire toute la documentation ;
* rédiger le plan détaillé ;
* écrire le code ;
* générer les tests ;
* lancer les benchmarks ;
* analyser les logs complets ;
* traiter tous les findings Codex.

## 5.2 Opus : direction opérationnelle

Opus est responsable de :

* synthétiser les recherches Sonnet ;
* proposer l’architecture détaillée ;
* rédiger ou finaliser la spécification ;
* construire le plan d’implémentation ;
* transformer les tâches du plan en contrats Sonnet ;
* organiser les vagues de travail ;
* contrôler les dépendances ;
* vérifier les rapports Sonnet ;
* adjudication des findings Codex ;
* décider des corrections locales ;
* escalader vers Fable uniquement les questions de direction.

Opus est le principal responsable de la cohérence technique.

## 5.3 Sonnet : volume opérationnel

Sonnet réalise :

* exploration du dépôt ;
* inventaire des composants ;
* consultation de documentation ;
* recherche d’API ;
* lecture des fichiers ;
* recherche des tests existants ;
* génération et exécution de tests ;
* implémentation de tâches planifiées ;
* corrections mécaniques ;
* reproduction de bugs ;
* benchmarks ;
* lint, typecheck et builds ;
* collecte des preuves ;
* comparaison entre résultats attendus et résultats observés.

L’exécution du plan est confiée en priorité à Sonnet, puisque le travail a précisément été spécifié et découpé pour devenir exécutable.

## 5.4 Le bypass Fable → Sonnet

Fable peut lancer directement un Sonnet lorsque les quatre conditions suivantes sont réunies :

1. la tâche est parfaitement bornée ;
2. elle ne contient aucun arbitrage architectural ;
3. son résultat est objectivement vérifiable ;
4. le passage par Opus ne réduirait pas le risque.

Exemples :

* localiser une API ;
* inventorier les tests ;
* vérifier la présence d’une configuration ;
* produire une liste de fichiers ;
* lancer une suite de tests et résumer les erreurs.

Le bypass ne doit pas devenir le chemin normal d’implémentation.

---

# 6. Ratio de charge 1–3–9

## 6.1 Ce ratio ne doit pas être un nombre fixe d’agents

Le ratio :

```text
Fable travaille 1
Opus travaille 3
Sonnet travaille 9
```

doit être compris comme une cible de distribution du travail, et non comme l’obligation de lancer exactement treize agents.

Une feature minuscule pourrait nécessiter :

```text
1 décision Fable
1 opération Opus
2 opérations Sonnet
```

Une feature complexe pourrait nécessiter :

```text
3 décisions Fable
10 opérations Opus
35 opérations Sonnet
```

Ce qui compte est la proportion.

## 6.2 Indicateurs de pilotage

Hyperpowers mesurera séparément :

* nombre de décisions par modèle ;
* nombre de work packages ;
* tokens d’entrée ;
* tokens de sortie ;
* coût estimé ;
* durée ;
* nombre de retries ;
* part du travail refaite par un modèle supérieur ;
* taux d’acceptation des résultats Sonnet ;
* taux d’escalade Sonnet → Opus ;
* taux d’escalade Opus → Fable.

Cibles initiales :

| Indicateur                   |           Fable |         Opus |          Sonnet |
| ---------------------------- | --------------: | -----------: | --------------: |
| Work packages                |          ≤ 10 % |      20–30 % |         60–70 % |
| Tokens de sortie             |          ≤ 10 % |      20–25 % |          ≥ 65 % |
| Travail opérationnel         |       Quasi nul |       Limité |     Majoritaire |
| Décisions produit            |    Majoritaires |    Préparées |          Aucune |
| Décisions techniques locales | Exceptionnelles | Majoritaires | Recommandations |

Ces seuils constituent des objectifs d’observation, pas des blocages absolus.

## 6.3 Le paquet décisionnel envoyé à Fable

Opus ne doit pas transmettre ses recherches complètes à Fable.

Chaque remontée prendra la forme suivante :

```text
DECISION PACKET

Décision requise :
Une phrase.

Pourquoi maintenant :
Deux ou trois phrases.

Options :
Maximum trois options.

Recommandation Opus :
Une option clairement recommandée.

Éléments de preuve :
Chemins ou identifiants, sans logs bruts.

Risque si la décision est incorrecte :
Une courte description.

Réponse attendue de Fable :
APPROVE / REDIRECT / REQUEST_EVIDENCE
```

Taille cible : 500 à 1 000 tokens.

Le rapport de `fable-advisor` recommande déjà que le modèle supérieur émette un verdict plutôt qu’une étude exhaustive. Hyperpowers transforme cette idée en protocole obligatoire.

---

# 7. Choix des niveaux d’effort

## 7.1 Limites des benchmarks fournis

Les résultats transmis correspondent aux données publiques actuelles de CursorBench 3.2. Cette évaluation porte sur des tâches agentiques ambiguës et multifichiers issues de sessions Cursor. Elle mesure donc principalement la capacité à résoudre des tâches de programmation longues, pas directement :

* la vision produit ;
* la qualité d’une architecture ;
* la qualité d’une review ;
* la fidélité à une intention utilisateur ;
* la capacité à superviser d’autres agents.

Ces chiffres constituent un bon prior de routage, mais pas une vérité universelle.

## 7.2 Lecture économique des résultats

Passer de High à Xhigh produit :

| Modèle   | Gain de score | Surcoût |
| -------- | ------------: | ------: |
| Fable 5  |    +1,9 point | +33,8 % |
| Opus 5   |   +2,6 points | +88,0 % |
| Sonnet 5 |    +1,8 point | +30,4 % |

Sur un panier théorique de :

```text
1 tâche Fable
3 tâches Opus
9 tâches Sonnet
```

le coût est approximativement :

```text
Tout High   : 49,21 $
Tout Xhigh  : 71,22 $
```

Le tout-High représente environ 69 % du coût du tout-Xhigh, soit une économie d’environ 31 %.

Ce calcul est seulement illustratif : une tâche CursorBench n’est pas équivalente à une invocation Hyperpowers. Il montre néanmoins que l’utilisation systématique de Xhigh détruirait une partie importante du bénéfice économique de la pyramide.

## 7.3 Politique retenue

### Fable

```text
High par défaut
Xhigh pour :
- verrouillage d’un design à fort impact ;
- décision produit ambiguë ;
- conflit majeur Opus/Codex ;
- acceptation finale risquée.
```

### Opus

```text
High par défaut
Xhigh pour :
- architecture transversale complexe ;
- sécurité, concurrence, migrations ou intégrité de données ;
- adjudication d’un finding Codex bloquant ;
- diagnostic après plusieurs échecs Sonnet.
```

Le résultat Opus est particulièrement clair : Xhigh coûte près de 88 % de plus que High pour un gain CursorBench de 2,6 points. Xhigh ne doit donc pas être son régime permanent.

### Sonnet

```text
High par défaut
Xhigh pour :
- deuxième tentative après échec ;
- implémentation locale difficile ;
- génération de tests complexes ;
- diagnostic d’un comportement non déterministe.
```

### Medium et Max

Medium n’est pas utilisé par défaut, même pour les opérations mécaniques, conformément à ton expérience et à la chute de performance observée chez Sonnet.

Max est désactivé par défaut. La documentation elle-même recommande de réserver Max aux problèmes les plus difficiles, car son coût et sa durée augmentent fortement et la plupart des tâches n’en ont pas besoin.

## 7.4 Profil de qualité Hyperpowers

Le profil initial sera :

```yaml
fable:
  default: high
  escalation: xhigh

opus:
  default: high
  escalation: xhigh

sonnet:
  default: high
  escalation: xhigh

max:
  enabled: false

medium:
  enabled: false
```

---

# 8. Utilisation de Codex adversarial review

## 8.1 Pourquoi `adversarial-review` est le bon concept

`/codex:adversarial-review` est meilleur que `/codex:review` pour Hyperpowers, car il ne recherche pas seulement des bugs locaux.

Il remet en cause :

* l’approche choisie ;
* les hypothèses ;
* les compromis ;
* les failure modes ;
* la simplicité de la solution ;
* les alternatives plus sûres ;
* la cohérence entre architecture et implémentation.

La commande officielle est explicitement décrite comme une review orientée challenge, capable de pressure-tester le design et les choix d’implémentation.

La modification proposée est donc validée sur le fond.

## 8.2 Ce que cette modification ne règle pas

Le remplacement de `/codex:review` par `/codex:adversarial-review` ne règle cependant pas tous les problèmes d’automatisation.

La commande actuelle possède :

```yaml
disable-model-invocation: true
```

Claude ne peut donc pas l’invoquer normalement depuis son propre workflow.

Elle utilise également le même mécanisme de sélection de cible que `/codex:review` :

* working tree ;
* branche ;
* base Git ;
* fichiers non suivis.

Elle n’est pas nativement conçue pour reviewer uniquement un document Markdown externe au diff.

Enfin, la version actuelle du companion transmet correctement `--model`, mais ignore silencieusement l’effort demandé pour `review` et `adversarial-review`. L’effort utilisé provient alors de la configuration Codex globale ou projet.

## 8.3 Décision : adaptateur Hyperpowers

Hyperpowers ne tentera pas de taper littéralement la commande slash.

Il embarquera un adaptateur :

```text
codex-adversary
```

Cet adaptateur conservera :

* le framing adversarial ;
* la lecture seule ;
* la structure des findings ;
* les critères de challenge ;
* la séparation reviewer/implementer ;
* les modèles Sol et Luna ;
* l’exécution foreground ;
* les sorties structurées.

Mais il maîtrisera lui-même :

* le document exact à reviewer ;
* le modèle ;
* l’effort ;
* le sandbox ;
* le timeout ;
* la validation JSON ;
* la taille du review pack ;
* les retries ;
* le fallback autorisé.

La philosophie et le protocole d’`adversarial-review` sont donc conservés, mais l’appel technique passe par une infrastructure Hyperpowers contrôlable.

## 8.4 Pourquoi ne pas modifier `.codex/config.toml` entre les rounds

Codex permet une configuration utilisateur et une configuration projet. Les configurations projet ne sont chargées que si le projet est approuvé comme trusted. Les flags CLI et les overrides `--config` ont une priorité supérieure à ces fichiers.

Modifier `.codex/config.toml` avant chaque review créerait plusieurs problèmes :

* modification du workspace ;
* risque de concurrence ;
* risque de laisser une configuration incorrecte après un crash ;
* pollution de la configuration utilisateur ;
* comportement dépendant du trust du projet ;
* difficulté à prouver quel effort a réellement été utilisé.

Hyperpowers devra donc passer explicitement le modèle et l’effort à chaque invocation.

Exemple conceptuel :

```text
codex exec
  --model gpt-5.6-sol
  --sandbox read-only
  --config model_reasoning_effort='"high"'
```

Le nom correct n’est pas :

```text
gpt-5.6-sol-high
```

mais :

```text
model = gpt-5.6-sol
effort = high
```

Les modèles disponibles sont notamment `gpt-5.6-sol`, `gpt-5.6-terra` et `gpt-5.6-luna`. OpenAI présente Sol comme le modèle adapté aux problèmes complexes et ouverts, tandis que Luna est destiné aux tâches claires, répétables et à fort volume.

## 8.5 Répartition des six reviews

| Round | Artefact                | Type de review                  | Modèle             |
| ----: | ----------------------- | ------------------------------- | ------------------ |
|     1 | Design                  | Review générale et adversariale | GPT-5.6 Sol High   |
|     2 | Design corrigé          | Vérification ciblée             | GPT-5.6 Luna Xhigh |
|     3 | Plan                    | Review générale et adversariale | GPT-5.6 Luna Xhigh |
|     4 | Plan corrigé            | Vérification ciblée             | GPT-5.6 Luna Xhigh |
|     5 | Implémentation          | Review générale et adversariale | GPT-5.6 Luna Xhigh |
|     6 | Implémentation corrigée | Review finale ciblée            | GPT-5.6 Sol High   |

Ce choix forme un bon compromis :

* Sol ouvre le cycle en challengeant la direction générale ;
* Luna traite les revues intermédiaires plus structurées ;
* Sol ferme le cycle en vérifiant l’ensemble livré.

Luna n’est pas supposé égaler Sol sur le jugement architectural. Son rôle est de traiter un artefact déjà structuré, avec des critères précis et un format de sortie contraint.

## 8.6 Fallback

Politique :

```text
Sol High indisponible
→ Luna Xhigh
→ événement FALLBACK_REVIEW_MODEL enregistré

Luna Xhigh indisponible
→ BLOCKED

Aucun fallback silencieux vers un autre modèle.
```

## 8.7 Indépendance entre les rounds

Le deuxième round ne doit pas simplement répéter le premier.

Cycle obligatoire :

```text
Review générale
→ adjudication Opus
→ correction
→ review ciblée
```

Le deuxième reviewer reçoit :

* l’artefact corrigé ;
* les findings du premier round ;
* les décisions d’adjudication ;
* les modifications annoncées ;
* les critères de re-review.

Il doit vérifier :

1. que les corrections acceptées sont effectives ;
2. qu’elles répondent au finding ;
3. qu’elles n’introduisent pas de nouvelle régression ;
4. que les findings rejetés l’ont été pour une raison valide ;
5. qu’aucun blocker évident ne subsiste.

---

# 9. Adjudication des findings Codex

Codex n’est jamais l’autorité finale.

Chaque finding prendra la forme suivante :

```json
{
  "id": "DESIGN-001",
  "severity": "high",
  "category": "architecture",
  "artifact": "design",
  "location": "data-model",
  "claim": "Description du problème",
  "evidence": ["élément 1", "élément 2"],
  "recommendation": "Correction proposée",
  "blocking": true,
  "confidence": 0.87
}
```

Opus produira ensuite :

```json
{
  "finding_id": "DESIGN-001",
  "decision": "accepted",
  "rationale": "Raison de la décision",
  "correction_owner": "opus",
  "required_change": "Modification à effectuer",
  "verification": "Comment vérifier",
  "escalate_to_fable": false
}
```

Décisions possibles :

```text
ACCEPTED
REJECTED
NEEDS_EVIDENCE
DUPLICATE
OUT_OF_SCOPE
DEFERRED_NON_BLOCKING
ESCALATED_TO_FABLE
```

Fable ne reçoit que :

* les findings affectant le produit ;
* les findings affectant le scope ;
* les décisions architecturales irréversibles ;
* les findings critiques contestés ;
* les risques résiduels significatifs.

---

# 10. Contrat d’interaction utilisateur

## 10.1 Interaction 1 : description de la feature

L’utilisateur lance :

```text
/hyperpowers:feature <description>
```

Fable enregistre :

* l’intention ;
* le résultat attendu ;
* les contraintes exprimées ;
* les éléments explicitement exclus ;
* le contexte initial.

## 10.2 Interaction 2 : brainstorming

Hyperpowers invoque `superpowers:brainstorming`.

L’utilisateur répond aux questions nécessaires. Il peut s’agir de plusieurs messages au sein d’une seule phase interactive.

Le brainstorming reste le seul endroit où Claude peut normalement utiliser `AskUserQuestion`.

## 10.3 Fin des interactions normales

Une fois que Fable considère que les réponses permettent de produire un design candidat, l’état passe à :

```text
AUTONOMOUS
```

À partir de là :

* aucun agent ne demande une validation utilisateur ;
* aucune préférence mineure n’est remontée ;
* les ambiguïtés locales sont résolues par Opus ;
* les ambiguïtés produit sont arbitrées par Fable ;
* les impossibilités externes conduisent à `BLOCKED`.

## 10.4 Validation automatique du design

La validation du design ne correspond plus à une validation utilisateur.

Elle correspond au gate suivant :

```text
Questions de brainstorming terminées
ET design produit
ET review Codex 1 terminée
ET findings adjudicés
ET corrections appliquées
ET review Codex 2 terminée
ET aucun blocker accepté ouvert
ET Fable confirme la cohérence produit
```

Le design est alors marqué :

```text
DESIGN_LOCKED
```

Cette adaptation respecte l’esprit de Superpowers tout en remplaçant son approbation humaine intermédiaire par un processus de validation autonome.

---

# 11. Machine à états

```text
PREFLIGHT
↓
INTAKE
↓
BRAINSTORMING
↓
WAITING_FOR_USER
↓
DESIGN_DRAFT
↓
DESIGN_REVIEW_1
↓
DESIGN_REMEDIATION
↓
DESIGN_REVIEW_2
↓
DESIGN_LOCK
↓
PLAN_DRAFT
↓
PLAN_REVIEW_1
↓
PLAN_REMEDIATION
↓
PLAN_REVIEW_2
↓
PLAN_LOCK
↓
EXECUTION
↓
SYSTEM_VERIFICATION
↓
IMPLEMENTATION_REVIEW_1
↓
IMPLEMENTATION_REMEDIATION
↓
IMPLEMENTATION_REVIEW_2
↓
FINAL_ACCEPTANCE
↓
COMPLETE
```

États terminaux alternatifs :

```text
BLOCKED
ABORTED
BUDGET_EXCEEDED
POLICY_VIOLATION
```

Chaque transition doit enregistrer :

* phase précédente ;
* nouvelle phase ;
* timestamp ;
* agent responsable ;
* artefact produit ;
* preuve de transition ;
* coût observé ;
* éventuels fallbacks ;
* problèmes encore ouverts.

---

# 12. Workflow détaillé

## Phase 0 — Preflight

Vérifications :

* version minimale de Claude Code ;
* disponibilité de Fable 5 ;
* disponibilité d’Opus 5 ;
* disponibilité de Sonnet 5 ;
* présence et version compatible de Superpowers ;
* présence du CLI Codex ;
* authentification Codex ;
* disponibilité de Sol et Luna ;
* environnement Git détectable ;
* absence d’opération Git mutante en cours ;
* commandes de tests détectables ;
* droits d’écriture sur le projet ;
* dossier de données Hyperpowers disponible.

Aucun fallback implicite n’est autorisé.

## Phase 1 — Brainstorming

Fable :

1. invoque `superpowers:brainstorming` ;
2. délègue à Sonnet l’exploration nécessaire ;
3. demande à Opus une synthèse technique si utile ;
4. interagit avec l’utilisateur ;
5. produit un besoin consolidé ;
6. transmet à Opus un brief de design.

La validation finale normalement demandée par Superpowers est remplacée par le cycle Codex et le gate Fable.

## Phase 2 — Design

Opus :

1. consolide les recherches ;
2. compare les approches ;
3. produit le design ;
4. cartographie les critères d’acceptation ;
5. identifie les risques ;
6. prépare le review pack.

### Review design 1

Codex Sol High challenge :

* la direction ;
* la complexité ;
* les hypothèses ;
* les alternatives ;
* le modèle de données ;
* les interfaces ;
* les failure modes ;
* le scope.

### Remédiation

Opus adjudique les findings et corrige.

Fable est consulté uniquement lorsque le finding affecte l’intention produit ou un compromis structurant.

### Review design 2

Codex Luna Xhigh vérifie les corrections et les risques résiduels.

### Lock

Fable reçoit un decision packet et produit :

```text
APPROVE_DESIGN
ou
REDIRECT_DESIGN
```

## Phase 3 — Planification

Hyperpowers invoque `superpowers:writing-plans` avec une surcouche permanente :

```text
- ne pas créer de worktree ;
- ne pas créer de branche ;
- ne pas effectuer de commit ;
- ne pas demander de validation utilisateur ;
- mapper chaque tâche à un critère d’acceptation ;
- indiquer les fichiers concernés ;
- indiquer le test ou la preuve attendue ;
- séparer les tâches indépendantes ;
- marquer les dépendances ;
- préciser le modèle et l’effort recommandé ;
- préciser les risques de concurrence.
```

Opus transforme le plan en work packages Sonnet.

### Review plan 1

Codex Luna Xhigh cherche :

* les oublis ;
* les dépendances incorrectes ;
* les tâches trop grandes ;
* les validations manquantes ;
* les risques de régression ;
* la divergence entre design et plan ;
* les tâches impossibles à vérifier.

### Remédiation et review plan 2

Même cycle que pour le design.

Le plan est verrouillé lorsque :

* chaque critère d’acceptation est couvert ;
* chaque tâche possède une preuve ;
* les dépendances sont cohérentes ;
* aucun blocker accepté ne reste ouvert.

## Phase 4 — Exécution

Hyperpowers invoque `superpowers:executing-plans`.

Le workflow `subagent-driven-development` n’est pas utilisé.

Pour chaque tâche :

```text
LOAD_CONTRACT
↓
DISCOVER
↓
IMPLEMENT
↓
SELF_VERIFY
↓
REPORT
↓
OPUS_CHECK
↓
ACCEPT ou REMEDIATE
```

Sonnet réalise normalement l’implémentation.

Opus n’écrit directement du code que dans les cas suivants :

* correction architecturale difficile à déléguer ;
* échec répété de Sonnet ;
* modification à très fort risque ;
* correction extrêmement limitée nécessitant une compréhension globale.

Fable n’implémente pas.

## Phase 5 — Vérification système

Sonnet vérifie :

* tests unitaires ;
* tests d’intégration ;
* tests end-to-end lorsque disponibles ;
* lint ;
* typecheck ;
* build ;
* tests de non-régression ;
* critères d’acceptation ;
* comportement runtime ;
* absence de TODO involontaire ;
* absence de mock ou placeholder résiduel ;
* absence de modification hors scope.

Opus vérifie la cohérence du dossier de preuves.

## Phase 6 — Review implémentation 1

Codex Luna Xhigh effectue une review adversariale générale du working tree.

Le review pack comprend :

* besoin verrouillé ;
* design verrouillé ;
* plan verrouillé ;
* diff Git en lecture seule ;
* liste des fichiers modifiés ;
* résultats de tests ;
* matrice critères/preuves ;
* risques connus.

## Phase 7 — Remédiation finale

Opus adjudique.

Sonnet corrige les findings acceptés.

Le même Sonnet peut être repris lorsqu’un finding concerne directement son implémentation, afin de conserver le contexte local. Un Sonnet frais est préféré lorsque le problème révèle une hypothèse biaisée ou une incompréhension générale.

## Phase 8 — Review implémentation 2

Codex Sol High vérifie :

* les corrections ;
* les risques critiques ;
* l’adéquation au besoin ;
* les régressions ;
* l’intégrité de l’architecture ;
* la simplicité ;
* la qualité des preuves ;
* la possibilité réelle de déclarer la feature terminée.

## Phase 9 — Acceptation finale

Fable reçoit uniquement :

* résumé du besoin ;
* critères d’acceptation ;
* statut de chaque critère ;
* tests ;
* findings ouverts ;
* risques résiduels ;
* recommandation Opus ;
* verdict final Codex.

Fable décide :

```text
COMPLETE
REMEDIATE
BLOCKED
```

---

# 13. Définition de « terminé »

Une feature n’est pas terminée uniquement parce que les tests existants passent.

Des tests verts peuvent simplement signifier que les comportements manquants ne sont pas testés.

Hyperpowers déclare `COMPLETE` uniquement si :

```text
1. Tous les critères d’acceptation ont une preuve.
2. Tous les tests requis passent.
3. Le build passe lorsqu’il existe.
4. Le lint et le typecheck passent lorsqu’ils existent.
5. Les tests ajoutés échouaient avant la correction lorsque cela est vérifiable.
6. Aucun finding critique accepté n’est ouvert.
7. Aucun finding high bloquant accepté n’est ouvert.
8. La deuxième review d’implémentation est terminée.
9. Les corrections annoncées ont été vérifiées.
10. Aucun fichier hors scope n’a été modifié sans justification.
11. Aucune mutation Git n’a été exécutée.
12. Aucun fallback de modèle n’a été dissimulé.
13. Fable donne l’acceptation finale.
14. Une fois l'acceptation finale donnée, un diagramme Mermaid simple, oriente produit et vision business est généré dans un Artifact (Skill(artifact-design)), rendu disponible via claude.ai, et présenté à l'utilisateur final.
```

Ta règle est donc validée avec une précision :

> Deux rounds Codex finaux et tous les tests au vert permettent de terminer, à condition que les tests et les preuves couvrent effectivement les critères d’acceptation.

---

# 14. Politique Git

## 14.1 Principe

```text
Lecture Git autorisée.
Mutation Git interdite.
```

## 14.2 Commandes autorisées

Exemples :

```text
git status
git diff
git diff --stat
git diff --name-only
git log
git show
git ls-files
git rev-parse
git merge-base
git cat-file
git grep
git branch --show-current
```

Les options doivent elles-mêmes rester en lecture seule.

## 14.3 Commandes interdites

```text
git add
git commit
git checkout
git switch
git restore
git reset
git merge
git rebase
git cherry-pick
git revert
git stash
git clean
git branch <création ou suppression>
git tag
git push
git pull
git fetch
git worktree
git init
git clone
git apply
git am
git update-index
git config
git gc
git maintenance
```

`git fetch` est interdit parce qu’il modifie les références locales, même s’il ne modifie pas directement les fichiers de travail.

## 14.4 Contrôle déterministe

Un hook `PreToolUse` contrôlera :

* les commandes Bash ;
* les chaînes avec `&&`, `;`, pipes ou substitutions ;
* les usages de `git -C` ;
* les variables `GIT_DIR` et `GIT_WORK_TREE` ;
* les alias ;
* les écritures dans `.git/` ;
* les appels indirects depuis un script.

Une simple regex ne suffira pas.

Le hook analysera la commande, la décomposera et refusera toute commande qu’il ne peut pas classer de manière sûre.

Les permissions Claude Code peuvent bloquer des outils ou commandes, mais les règles `deny` prennent le dessus sur les règles `allow`, sans mécanisme d’exception précis à l’intérieur d’un deny trop large. Un hook spécialisé est donc mieux adapté à une politique Git autorisant certaines lectures.

---

# 15. Concurrence et absence de worktrees

L’interdiction des worktrees a une conséquence importante :

> Plusieurs Sonnet ne doivent pas modifier simultanément les mêmes fichiers dans le même working tree.

Hyperpowers distinguera deux types de parallélisme.

## Parallélisme libre

Autorisé pour :

* recherche ;
* lecture ;
* documentation ;
* analyse de tests ;
* inventaire ;
* review ;
* benchmarks read-only ;
* préparation de propositions.

## Parallélisme d’écriture contrôlé

Les implémentations peuvent être parallèles uniquement si :

* les ensembles de fichiers sont disjoints ;
* aucune tâche ne dépend du résultat immédiat de l’autre ;
* Opus attribue explicitement la propriété des fichiers ;
* un verrou de fichier logique est enregistré.

Sinon, l’exécution est séquentielle.

Le ratio 1–3–9 représente donc un volume de travail, pas neuf Sonnet écrivant simultanément dans le même dépôt.

---

# 16. Hooks et maintien de l’autonomie

## 16.1 Pourquoi les hooks remplacent `/goal`

Les hooks peuvent :

* bloquer une opération avant son exécution ;
* empêcher Claude de s’arrêter ;
* contrôler la fin d’un sous-agent ;
* valider une tâche ;
* injecter une raison de continuer.

Les hooks sont conçus pour garantir les comportements déterministes qui ne doivent pas dépendre du respect d’un prompt.

## 16.2 Hook `Stop`

Le hook lit l’état courant.

```text
WAITING_FOR_USER
→ autoriser l’arrêt

COMPLETE
→ autoriser l’arrêt

BLOCKED
→ autoriser l’arrêt

ABORTED
→ autoriser l’arrêt

Tout autre état
→ bloquer l’arrêt et indiquer la prochaine action
```

Claude Code impose normalement un plafond de huit blocages consécutifs du hook `Stop`, mais ce plafond peut être augmenté avec `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`. Le hook doit également examiner `stop_hook_active` pour ne pas provoquer une boucle triviale.

Hyperpowers recommandera :

```text
CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=32
```

Il ne suffira pas d’augmenter le plafond. La machine à états devra prouver un progrès entre deux continuations.

## 16.3 Détection d’absence de progrès

À chaque continuation, le système compare :

* phase ;
* tâche active ;
* artefact modifié ;
* statut des tests ;
* compteur de findings ;
* horodatage ;
* hash de l’état.

Si aucune progression n’est détectée pendant plusieurs cycles :

```text
1er échec → retry Sonnet
2e échec → escalade Opus
3e échec systémique → escalade Fable
échec persistant → BLOCKED
```

## 16.4 Hook `SubagentStop`

Le hook valide que chaque agent retourne un rapport conforme.

Un Sonnet ne peut pas terminer avec :

```text
Done.
```

Il doit indiquer :

```text
- statut ;
- fichiers lus ;
- fichiers modifiés ;
- tests lancés ;
- résultats ;
- éléments non vérifiés ;
- risques ;
- preuves ;
- recommandation.
```

Un rapport invalide est rejeté une fois pour correction.

## 16.5 Hook `PreToolUse`

Il applique :

* politique Git ;
* protection de `.git/` ;
* blocage des opérations externes interdites ;
* limites des commandes destructrices ;
* respect des chemins autorisés ;
* interdiction de lancer les workflows Claude Code non prévus.

---

# 17. Désactivation d’Advisor et des Workflows

Advisor sera désactivé avec :

```text
CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1
```

Cette variable retire l’outil Advisor, rend `/advisor` indisponible et ignore le modèle Advisor éventuellement configuré.

Les instructions Git intégrées seront retirées avec :

```text
CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
```

Cela ne bloque pas Git, mais retire du prompt système les instructions relatives aux commits et pull requests.

Pour les workflows :

* dans un environnement administré, utiliser `disableWorkflows: true` ;
* sinon, bloquer l’outil `Workflow` par permission ;
* éventuellement définir `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`, ce qui retire les skills et workflows bundled sans supprimer les skills installés par plugins.

Hyperpowers ne doit pas dépendre d’une variable non documentée telle que `CLAUDE_CODE_DISABLE_WORKFLOWS`.

---

# 18. Circuit breakers

## Par tâche Sonnet

```text
Tentative 1 : Sonnet High
Tentative 2 : Sonnet Xhigh avec diagnostic
Tentative 3 : Opus High ou Xhigh
Échec : replanification ou BLOCKED
```

## Par review Codex

Six rounds sont obligatoires.

Si le deuxième round d’un artefact découvre un nouveau blocker :

```text
correction
→ une review ciblée supplémentaire maximum
```

Si un blocker critique reste après cette review supplémentaire :

```text
BLOCKED
```

Fable peut accepter un risque résiduel non critique, mais ne doit pas déclarer terminé en présence d’un défaut critique accepté.

## Globalement

Le plugin possédera :

* un budget maximal configurable ;
* une durée maximale configurable ;
* un nombre maximal de work packages ;
* un nombre maximal de reviews supplémentaires ;
* une limite de tentatives par tâche ;
* un compteur de fallbacks.

La borne ne sert pas à interrompre arbitrairement une feature saine. Elle empêche une boucle défaillante de consommer indéfiniment des tokens.

---

# 19. Architecture technique du plugin

```text
hyperpowers/
├── .claude-plugin/
│   └── plugin.json
│
├── skills/
│   ├── feature/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── workflow.md
│   │       ├── superpowers-adaptation.md
│   │       ├── routing-policy.md
│   │       ├── completion-contract.md
│   │       └── git-policy.md
│   │
│   ├── resume/
│   │   └── SKILL.md
│   │
│   ├── status/
│   │   └── SKILL.md
│   │
│   └── setup/
│       └── SKILL.md
│
├── agents/
│   ├── fable-director.md
│   ├── fable-gate-reviewer.md
│   ├── opus-design-coordinator.md
│   ├── opus-plan-coordinator.md
│   ├── opus-execution-coordinator.md
│   ├── opus-review-adjudicator.md
│   ├── sonnet-researcher.md
│   ├── sonnet-implementer.md
│   ├── sonnet-test-engineer.md
│   └── sonnet-verifier.md
│
├── hooks/
│   └── hooks.json
│
├── scripts/
│   ├── preflight.mjs
│   ├── state-machine.mjs
│   ├── stop-controller.mjs
│   ├── git-policy.mjs
│   ├── validate-agent-report.mjs
│   ├── build-review-pack.mjs
│   ├── codex-adversary.mjs
│   ├── adjudication-ledger.mjs
│   ├── verify-completion.mjs
│   └── telemetry.mjs
│
├── schemas/
│   ├── state.schema.json
│   ├── work-package.schema.json
│   ├── agent-report.schema.json
│   ├── finding.schema.json
│   ├── adjudication.schema.json
│   └── completion.schema.json
│
├── prompts/
│   ├── design-adversarial-review.md
│   ├── plan-adversarial-review.md
│   ├── implementation-adversarial-review.md
│   ├── targeted-rereview.md
│   └── fable-decision-packet.md
│
└── templates/
    ├── state.json
    ├── task-ledger.json
    ├── evidence-matrix.json
    └── final-report.md
```

---

# 20. Stockage des données

Les données internes ne doivent pas polluer le working tree, notamment parce que Codex doit pouvoir examiner les véritables modifications du projet sans inclure les logs Hyperpowers.

Les données seront stockées dans :

```text
${CLAUDE_PLUGIN_DATA}/projects/<project-hash>/runs/<run-id>/
```

Claude Code prévoit `${CLAUDE_PLUGIN_DATA}` comme répertoire persistant pour les dépendances installées, caches, données générées et autres données survivant aux mises à jour du plugin.

Structure :

```text
run-id/
├── state.json
├── request.md
├── brainstorm-summary.md
├── design.md
├── plan.md
├── tasks.json
├── evidence.json
├── telemetry.jsonl
├── reviews/
│   ├── design-1.json
│   ├── design-2.json
│   ├── plan-1.json
│   ├── plan-2.json
│   ├── implementation-1.json
│   └── implementation-2.json
└── final-report.md
```

Les documents destinés au projet peuvent ensuite être copiés dans un emplacement documentaire du dépôt, mais les fichiers d’orchestration restent hors du working tree.

---

# 21. Configuration des skills et agents

Le point d’entrée sera un skill manuel :

```yaml
---
name: feature
description: Build a software feature autonomously from brainstorming to verified implementation
disable-model-invocation: true
model: fable
effort: high
---
```

Les skills Claude Code peuvent imposer un modèle et un effort pour le tour où ils sont actifs. Les agents de plugin peuvent également déclarer leur modèle, leur effort et leur nombre maximal de tours.

Exemple Opus :

```yaml
---
name: opus-execution-coordinator
model: opus
effort: high
tools: Agent, Read, Grep, Glob, Bash
maxTurns: 40
---
```

Exemple Sonnet :

```yaml
---
name: sonnet-implementer
model: sonnet
effort: high
tools: Read, Grep, Glob, Edit, Write, Bash
disallowedTools: Agent
maxTurns: 30
---
```

Les hooks et permission modes définis directement dans les agents de plugin sont actuellement ignorés pour des raisons de sécurité. Les garanties communes doivent donc rester dans les hooks du plugin ou les paramètres de session.

---

# 22. Dépendances

## Superpowers

Superpowers est une dépendance fonctionnelle.

Hyperpowers doit :

* vérifier sa présence ;
* vérifier une version compatible ;
* invoquer ses skills ;
* appliquer ses propres surcharges ;
* refuser de démarrer si une version inconnue modifie substantiellement les contrats attendus.

Claude Code permet aux plugins de déclarer des dépendances accompagnées de contraintes semver.

## Codex

Le CLI Codex est une dépendance runtime obligatoire.

Le plugin Codex officiel peut être :

* déclaré comme dépendance pour bénéficier de son installation et de sa documentation ;
* utilisé manuellement par l’utilisateur ;
* suivi comme référence pour le comportement adversarial.

Cependant, l’automatisation principale utilisera l’adaptateur Hyperpowers, au moins tant que :

* `adversarial-review` reste non invocable par le modèle ;
* l’effort n’est pas correctement transmis ;
* les reviews de documents arbitraires ne sont pas isolables ;
* le runtime ne fournit pas une API stable directement consommable par un plugin tiers.

## `fable-advisor`

Aucune dépendance.

Les principes sont repris, mais l’implémentation ne l’est pas.

---

# 23. Principaux risques

## Risque 1 — Fable devient malgré tout trop bavard

Réponse :

* decision packets bornés ;
* aucun log brut ;
* aucun rapport Sonnet direct sauf bypass ;
* artefacts sur disque ;
* Fable ne relit pas toute l’implémentation ;
* réponses Fable orientées verdict.

## Risque 2 — Opus devient un second Fable coûteux

Réponse :

* Opus High par défaut ;
* Xhigh seulement sur escalade ;
* rapports Sonnet structurés ;
* planification par lots ;
* pas de réécriture systématique du travail Sonnet.

## Risque 3 — Sonnet produit du code médiocre malgré le plan

Réponse :

* petits work packages ;
* critères de vérification ;
* tests ;
* review Opus ;
* Codex indépendant ;
* reprise Xhigh ;
* escalade après deux tentatives.

## Risque 4 — Les six reviews deviennent répétitives

Réponse :

* round 1 général ;
* round 2 ciblé ;
* paquets différents ;
* instructions spécifiques ;
* vérification des corrections ;
* identifiants persistants des findings.

## Risque 5 — Codex consomme trop de tokens ou reste bloqué

Des incidents actuels montrent que certaines adversarial reviews longues peuvent consommer des dizaines de milliers de tokens sans retourner de message final conforme.

Réponse :

* review pack limité ;
* timeout ;
* suivi de progression ;
* sortie structurée obligatoire ;
* retry unique ;
* réduction du scope ;
* pas de background pour les six gates ;
* foreground déterministe.

## Risque 6 — Plusieurs Sonnet se marchent dessus

Réponse :

* parallélisme en lecture ;
* verrouillage logique des fichiers ;
* écritures séquentielles par défaut ;
* partition explicite des fichiers ;
* pas de worktrees.

## Risque 7 — Contexte perdu après compaction

La compaction seule n’est pas suffisante pour les agents de longue durée. Anthropic recommande des artefacts durables et des tâches incrémentales permettant à une nouvelle session de reprendre le travail.

Réponse :

* machine à états persistante ;
* ledger ;
* artefacts canoniques ;
* preuves ;
* reprise par `/hyperpowers:resume` ;
* aucune dépendance à la mémoire conversationnelle seule.

---

# 24. Stratégie d’évaluation

Le benchmark fourni est utile, mais Hyperpowers devra mesurer ses propres performances.

Configurations à comparer :

| Configuration | Description                      |
| ------------- | -------------------------------- |
| A             | Fable seul + Superpowers         |
| B             | Opus seul + Superpowers          |
| C             | Fable → Opus → Sonnet sans Codex |
| D             | Hyperpowers complet              |
| E             | Hyperpowers tout-High            |
| F             | Hyperpowers avec escalades Xhigh |

Mesures :

* coût total ;
* durée ;
* taux de réussite ;
* critères d’acceptation satisfaits ;
* bugs découverts après terminaison ;
* interventions utilisateur ;
* findings Codex valides ;
* faux positifs Codex ;
* retries ;
* proportion de tâches Sonnet acceptées au premier passage ;
* proportion de travail refait par Opus ;
* tokens consommés par Fable ;
* dérive du scope ;
* violations de politique ;
* reprise après interruption.

L’indicateur principal ne doit pas être :

```text
coût par tâche
```

mais :

```text
coût par feature correctement terminée
```

Une configuration moins chère à la première tentative peut être plus coûteuse si elle provoque davantage de retries ou de régressions. Anthropic recommande précisément de construire des évaluations multi-tours correspondant au comportement réel de l’agent, avec un environnement et des critères automatisés.

---

# 25. Définition finale de Hyperpowers

Hyperpowers est :

> Un plugin Claude Code de développement logiciel autonome et borné, utilisant Superpowers comme méthode, Fable comme autorité produit, Opus comme direction opérationnelle, Sonnet comme force d’exécution et Codex comme contradicteur indépendant.

Il transforme une demande utilisateur en :

```text
besoin clarifié
→ design adversarialement vérifié
→ plan adversarialement vérifié
→ implémentation testée
→ implémentation adversarialement vérifiée
→ décision finale fondée sur des preuves
```

Le plugin ne cherche pas à faire travailler le modèle le plus puissant le plus longtemps possible.

Il cherche à :

```text
utiliser le modèle le moins coûteux capable d’accomplir chaque tâche,
puis faire remonter uniquement les décisions qui justifient une intelligence supérieure.
```

---

# 26. Conclusion et architecture retenue

Les choix validés sont cohérents et techniquement réalisables.

La principale évolution apportée par cette nouvelle analyse est la suivante :

> L’autorité reste centralisée chez Fable, mais l’orchestration opérationnelle descend chez Opus.

Cela correspond mieux :

* à la métaphore CEO–COO–opérationnels ;
* aux capacités actuelles de sous-agents imbriqués ;
* au besoin de préserver le contexte de Fable ;
* au ratio 1–3–9 ;
* aux benchmarks de coût ;
* aux idées les plus solides de `fable-advisor`.

L’architecture finale est donc :

```text
Fable High
Direction produit, scope, gates et acceptation
│
├── Opus High
│   Coordination, architecture, planification, adjudication
│   │
│   ├── Sonnet High
│   │   Recherche et inventaire
│   │
│   ├── Sonnet High
│   │   Implémentation du plan
│   │
│   ├── Sonnet High
│   │   Tests et benchmarks
│   │
│   └── Sonnet High
│       Vérification et preuves
│
├── Sonnet direct
│   Tâches très simples et bornées
│
└── Fable ou Opus Xhigh
    Escalades rares et justifiées

Codex externe
Six reviews adversariales, avec Sol High aux deux extrémités
```

Hyperpowers devra être construit directement comme un plugin viable, avec :

* machine à états ;
* hooks ;
* adaptateur Codex ;
* politique Git ;
* contrats de délégation ;
* agents spécialisés ;
* preuves persistantes ;
* télémétrie ;
* reprise ;
* circuit breakers.

Cette architecture n’est pas présentée comme mathématiquement optimale avant expérimentation. Elle est cependant cohérente, mesurable, relativement simple au regard de son ambition et suffisamment déterministe pour servir de première version sérieuse du plugin.
La prochaine étape logique est la spécification technique exacte du plugin : manifeste, agents, schémas JSON, hooks et contenu du skill /hyperpowers:feature.

---

# 27. Annexes et ebauches de prompts

La sous-partie de l'architecture claude --> codex --> claude est basee sur un workflow manuel que l'utilisateur a pu utiliser. Vous trouverez dans cette annexe les ebauches de prompts qui sont utilisees pour transmettre les instructions. Ces prompts sont donnés tels quels, et ne sont pas toujours adaptes au format plugin. Ils servent de base pour la reflexion :

--------------------

I asked claude code to fix my audit issue; and it produced a complete spec plan at docs/superpowers/specs/2026-07-07-audit-artifact-shm-reliability-design.md . The problem it aim to solve and the approach and solution are detailled on this spec plan. Go through everything in great details, objectively and pragmatically. You should deeply understand and double check the problem it aim to solve, and then review in great details this spec plan and its approaches. Use expert software architect knowledges, and senior django python programming knowledges as well. But don't over-engineer, scope your review to spec plan. Double check everything, don't make any asumptions. Check if its respect DRY, evolutivity, maintenability. Review deeply this spec plan and tell me if its need changes before validating it and using it for implementation plan.

--------------------

Gorgias sidebar improvements spec plan have been validated, and we will move now to writing-plans phase with superpowers skill. So from now, @docs/superpowers/specs/2026-06-27-gorgias-in-sidebar-verdict-workflow-design.md is the main reference. So move to writing-plans. Don't make any asumptions, refer to the spec plan as primary reference and the codebase as secondary reference. Go through everything in great details, objectively and pragmatically. Use expert software architect knowledges and senior django python programming knowledges. Respect DRY, evolutivity, maintenability. Don't over engineer. Double check everything. Make a deep and hard work. Use as much time and as much resources as necessary to do a propper job. Only use top level Claude models like opus or better.

--------------------

I have made the docs/superpowers/specs/2026-06-20-zendesk-plugin-verdict-corrections-design.md spec plan. This document have been verified, and is the main reference document. The CLAUDE.md, [projet-context.md](.agent/rules/projet-context.md) and .agent/rules/radiance-scoring.md are second references. Your job, using superpowers skills, is to review the complete implementation plan on the docs/superpowers/plans/2026-06-20-zendesk-plugin-verdict-corrections.md file, which contains tasks implementation plans. You should on the implementation plans, review the whole process in great details. Use this spec plan as reference. Review all the tasks on the implementation plans and check if it respect DRY, evolutivity, maintenability. Don't over-engineer on your verification, use expert software architect knowledges, and senior django python knowledges. You're the expert so take all the objective and pragmatic decisions.
Make a deep and hard, pragmatic and objective analysis. Go through everyhting in great details. Double check everything, don't be lazy in any point. Make a deep and hard work.

--------------------

Implement the zendesk-plugin-verdict-corrections plans at docs/superpowers/plans/2026-06-20-zendesk-plugin-verdict-corrections.md; the spec at docs/superpowers/specs/2026-06-20-zendesk-plugin-verdict-corrections-design.md and all implementations tasks have been reviewed many times and are LOCKED.

Use the superpowers skills to walk each task's `- [ ]` steps in order, applying staff-level Django/Python software-architect judgment with strict adherence to CLAUDE.md (multi-tenant `for_organization().active()`, `transaction.atomic()` + `on_commit()` discipline, AuditLog NOT NULL contract, no PII in logs/stderr/AuditLog.changes, custom RBAC not Django Groups). Use @CLAUDE.md for coding guidelines as well. On your code and comments, don't mention parts of the plan (for example, ref to task 6.2 xxxxx).

Honor DRY, evolvability, and maintainability — but do NOT over-engineer: if the plan says "add this helper" you add exactly that helper, you do not refactor surrounding code, invent abstractions beyond what the step asks for, or design for hypothetical future requirements.

Go through every step objectively and pragmatically: read the file you are about to touch, verify the surrounding code matches the plan's assumptions (line numbers, signatures, existing patterns), run the test the step describes, and only mark the step done after you have empirical evidence it works.

Skip every git operation — no `git add`, no `git commit`, no `git push`, no branch creation; the user runs git themselves. Tick the git related box to continue your work.

Tick the `- [ ]` checkbox to `- [x]` ONLY when you are factually 100% confident the step is correctly done (the test passes, the file change matches the plan verbatim, no regressions in the suite) — never tick on intent or partial progress.

Run this verify-then-tick loop through all the tasks until every checkbox is ticked; if any step's premise no longer matches the code (a referenced line moved, a signature changed, a fixture missing), STOP and report the discrepancy rather than improvising. Use as much time and as much resources as necessary to do a propper job. Only use top level Claude AI models like opus or better.

--------------------

On my project, I have made the spec file docs/superpowers/specs/2026-06-20-zendesk-ai-classification-summary-design.md and the corresponding implementation plan on the docs/superpowers/plans/2026-06-20-zendesk-ai-classification-summary.md file. Both have been validated and are reference file, the implementation plan is the first reference, the spec plan the second reference. The CLAUDE.md, [projet-context.md](.agent/rules/projet-context.md) and .agent/rules/radiance-scoring.md are references as well. The implementation plan have been executed and implemented across the codebase. All the changes are the staged files (17 files). Your job will be to make a full review of the implementation done, checking if the implementation respect the spec and implementation plans, if the code implemented is healthy. Go through everything in great details. Don't over-engineer. Double check everything, objectively and pragmatically. Don't be lazy in any point. Use expert software architect knowledges, and senior django python programming knowledges as well. Check if it respect DRY, eovlutivity, maintenability. Make a deep and hard work. Use as much time and as much resources as necessary to do a propper job. Only use top level Claude models like opus or better.

--------------------

I asked codex to review the modifications, fixes and improvements you've done across the 17 staged changes, and it produced the following report. Analyze it in each details, objectively and pragmatically. For each findings, determine if it's right or wrong. If there is right finding, for each of those one, brainstorm and iterate until you are 100% confident with the approach elaborated to address the related finding. Make a deep and hard work :

--------------------