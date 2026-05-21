const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

const BASIC_LIMIT = 20

// ── Subscription helper ───────────────────────────────────────────────────────
async function getOrCreateSubscription(userId) {
  const today = new Date().toISOString().slice(0, 10)
  const [rows] = await pool.query('SELECT * FROM subscriptions WHERE user_id = ?', [userId])
  if (!rows.length) {
    await pool.query(
      'INSERT INTO subscriptions (user_id, plan, messages_used, last_reset_date) VALUES (?, "basic", 0, ?)',
      [userId, today]
    )
    const [created] = await pool.query('SELECT * FROM subscriptions WHERE user_id = ?', [userId])
    return created[0]
  }
  const sub = rows[0]
  const lastReset = sub.last_reset_date ? new Date(sub.last_reset_date).toISOString().slice(0, 10) : null
  if (lastReset !== today) {
    await pool.query('UPDATE subscriptions SET messages_used = 0, last_reset_date = ? WHERE user_id = ?', [today, userId])
    sub.messages_used = 0
  }
  return sub
}

// ── Conversation history ──────────────────────────────────────────────────────
async function getHistory(userId, limit = 8) {
  const [rows] = await pool.query(
    'SELECT message, response FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, limit]
  )
  return rows.reverse()
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(userCtx = '') {
  return `Tu es MediA, l'assistante santé intelligente de MedMap+, une application de santé pour la Côte d'Ivoire.

Comportement attendu :
- Réponds TOUJOURS en français, avec empathie et professionnalisme
- Pour les symptômes, pose des questions de triage précises (durée, intensité, symptômes associés)
- Ne donne jamais de diagnostic — oriente vers les professionnels de santé
- Mentionne les services MedMap+ quand c'est pertinent (pharmacies, RDV, urgences, commandes)
- En urgence vitale, donne immédiatement : SAMU 185, Police 111, Pompiers 180
- Termine toujours par rappeler que tu ne remplaces pas un médecin
- Sois concis : max 200 mots par réponse, utilise **gras** pour les points clés
- Connais les pathologies tropicales : paludisme, typhoïde, dengue, choléra, drépanocytose

Contexte MedMap+ disponible : pharmacies partenaires, rendez-vous médecins, commandes médicaments, urgences SAMU/pompiers/ambulances, suivi ordonnances, portefeuille électronique.${userCtx ? '\n\nUtilisateur : ' + userCtx : ''}`
}

// ── Gemini AI ─────────────────────────────────────────────────────────────────
async function callGemini(message, history, userCtx) {
  const { GoogleGenerativeAI } = require('@google/generative-ai')
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: buildSystemPrompt(userCtx),
  })
  const geminiHistory = history.flatMap(h => [
    { role: 'user', parts: [{ text: h.message }] },
    { role: 'model', parts: [{ text: h.response }] },
  ])
  const chat = model.startChat({ history: geminiHistory })
  const result = await chat.sendMessage(message)
  return result.response.text()
}

// ── Claude AI ─────────────────────────────────────────────────────────────────
async function callClaude(message, userCtx) {
  const Anthropic = require('@anthropic-ai/sdk')
  const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY })
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    system: buildSystemPrompt(userCtx),
    messages: [{ role: 'user', content: message }],
  })
  return response.content[0].text
}

// ── Main AI router ────────────────────────────────────────────────────────────
async function getAIResponse(message, userCtx = '', history = []) {
  if (process.env.GEMINI_API_KEY) {
    try { return await callGemini(message, history, userCtx) }
    catch (e) { console.error('[Gemini]', e.message) }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    try { return await callClaude(message, userCtx) }
    catch (e) { console.error('[Claude]', e.message) }
  }
  return smartFallback(message, history)
}

// ── Intelligent conversational fallback ──────────────────────────────────────
// Used only when NO API key is configured. Covers 25+ medical scenarios.
function smartFallback(message, history = []) {
  const m = message.toLowerCase()
  const prev = history.map(h => h.message.toLowerCase()).join(' ')

  // ── Emergency (absolute priority) ────────────────────────────────────────
  if (/douleur (thoracique|poitrine|coeur)|mal (au coeur|à la poitrine)|infarctus|avc|stroke|convulsion|inconscient|ne respire pas|arrêt cardiaque/.test(m))
    return `**Urgence médicale grave — appelez immédiatement.**\n\n**SAMU : 185** | Pompiers : 180\n\nNe bougez pas le patient. Desserrez les vêtements. Si inconscient et ne respire pas : commencez le bouche-à-bouche.\n\nJe peux activer une alerte MedMap+ pour l'hôpital le plus proche.\n\n⚠️ Appelez le 185 maintenant — chaque seconde compte.`

  if (/difficul(té|té) (à|de) respir|essoufflement|manque d'air|oppression|étouffement/.test(m))
    return `**Signes de détresse respiratoire — agissez vite.**\n\n• Si la personne est consciente : asseyez-la droite, col desserré\n• Si lèvres bleues ou perte de connaissance : **SAMU 185 immédiatement**\n\nCauses possibles : asthme, pneumonie, crise d'allergie sévère, COVID.\n\nAvez-vous des antécédents d'asthme ou d'allergie ? Avez-vous un inhalateur disponible ?`

  // ── Abdominal pain ────────────────────────────────────────────────────────
  if (/ventre|abdomen|estomac|colique|crampe.*(ventre|abdomen)|mal.*(ventre|estomac)|douleur.*(abdomen|ventre|estomac)|digestion/.test(m))
    return `Je comprends, les douleurs abdominales peuvent être inconfortables. Pour vous aider au mieux :\n\n**Quelques questions :**\n• Depuis combien de temps avez-vous cette douleur ?\n• Est-ce une crampe, une brûlure, ou une pression continue ?\n• Avez-vous aussi des nausées, vomissements ou diarrhée ?\n• Avez-vous de la fièvre ?\n\n**En attendant :**\n• Reposez-vous allongé, genoux pliés\n• Buvez de l'eau en petites gorgées\n• Le **Spasfon** (antispasmodique) soulage les crampes — disponible en pharmacie\n• Évitez les aliments épicés, laitages et alcool\n\n**Consultez en urgence si :** douleur soudaine et très intense, ventre dur comme une planche, sang dans les selles, fièvre > 38,5°C.\n\nJe peux vous trouver un médecin ou une pharmacie proche.`

  // ── Headache ──────────────────────────────────────────────────────────────
  if (/tête|céphalée|migraine|mal.*(tête|crâne)|douleur.*(tête|crâne)/.test(m))
    return `Les maux de tête ont plusieurs causes — voici quelques questions pour mieux vous orienter :\n\n**Précisez s'il vous plaît :**\n• Depuis combien de temps ? Intense ou modéré ?\n• La douleur est-elle d'un côté ou des deux côtés ?\n• Avez-vous aussi : vision floue, nausées, sensibilité à la lumière ?\n• Avez-vous bu assez d'eau aujourd'hui ?\n• Avez-vous de la fièvre ?\n\n**Conseils immédiats :**\n• Buvez 2 grands verres d'eau (déhydratation = cause fréquente)\n• Reposez-vous dans un endroit calme et sombre\n• **Paracétamol 500mg** ou **ibuprofène 400mg** si pas de contre-indication\n• Évitez les écrans et le bruit\n\n**Consultez en urgence si :** douleur soudaine et très intense ("pire douleur de ma vie"), raideur de la nuque, confusion, fièvre élevée.`

  // ── Sore throat ──────────────────────────────────────────────────────────
  if (/gorge|angine|enroué|voix (rauque|cassée|qui sort)|déglutir|avaler/.test(m))
    return `Les douleurs de gorge sont fréquentes sous les tropiques. Quelques questions :\n\n**Précisez :**\n• Avez-vous de la fièvre ?\n• Y a-t-il des plaques blanches visibles au fond de la gorge ?\n• Avez-vous du mal à avaler les liquides ?\n• Avez-vous été en contact avec quelqu'un de malade ?\n\n**Conseils :**\n• Gargarismes à l'eau salée tiède (1/2 c. à café de sel par verre)\n• **Paracétamol** pour la douleur et la fièvre\n• Buvez chaud (thé au miel au citron)\n• Évitez les aliments froids, les glaces\n• **Lozenges** (pastilles antiseptiques) disponibles en pharmacie\n\nSi fièvre > 38,5°C + plaques blanches : possible **angine bactérienne** nécessitant des antibiotiques — consultez un médecin pour une prescription.`

  // ── Back pain ─────────────────────────────────────────────────────────────
  if (/dos|lombaire|colonne|vertèbre|nuque|cervicale|sciatique|rein.*(douleur|mal)|mal.*(dos|reins|nuque)/.test(m))
    return `Les douleurs dorsales sont très courantes. Pour mieux vous orienter :\n\n**Précisez :**\n• La douleur est-elle en haut du dos, au milieu, ou dans le bas du dos ?\n• Est-ce que la douleur irradie vers les jambes ou les fesses ?\n• Avez-vous fait un mouvement brusque récemment ?\n• Y a-t-il des brûlures urinaires en plus ? (peut indiquer une infection rénale)\n\n**Conseils immédiats :**\n• Restez actif doucement — l'immobilité aggrave souvent\n• **Ibuprofène 400mg** (anti-inflammatoire) + **Paracétamol** si douleur forte\n• Chaleur locale (bouillotte) sur la zone douloureuse\n• Évitez de porter des charges lourdes\n\n**Consultez si :** douleur qui irradie jusqu'au pied, perte de sensibilité dans les jambes, brûlures urinaires ou fièvre associées.`

  // ── Skin / allergy ────────────────────────────────────────────────────────
  if (/peau|démangeaison|gratter|rougeur|bouton|éruption|urticaire|allergie|gale|eczéma|acné/.test(m))
    return `Les problèmes de peau peuvent avoir différentes causes. Quelques questions :\n\n**Précisez :**\n• Les démangeaisons sont-elles localisées ou généralisées ?\n• Avez-vous récemment changé de savon, parfum, vêtement ou aliment ?\n• Y a-t-il des rougeurs, gonflements, ou plaques ?\n• Avez-vous de la fièvre associée ?\n• D'autres personnes dans votre entourage ont-elles les mêmes symptômes ?\n\n**Conseils :**\n• Crème à la **cortisone** légère (disponible en pharmacie) pour les démangeaisons\n• **Antihistaminique** (Cétirizine, disponible sans ordonnance) si allergie suspectée\n• Évitez de vous gratter — cela aggrave\n• Utilisez du savon doux sans parfum\n\n**Consultez si :** gonflement du visage/gorge (urgence!), éruption qui s'étend rapidement, fièvre élevée, plaies qui s'infectent.`

  // ── Urinary infection ─────────────────────────────────────────────────────
  if (/urinaire|uriner|pipi|brûlure.*(urin|pipi)|envie.*(uriner|pipi)|cystite|prostate/.test(m))
    return `Les symptômes que vous décrivez peuvent indiquer une infection urinaire. Quelques questions :\n\n**Précisez :**\n• Avez-vous des brûlures en urinant ?\n• Urinez-vous plus fréquemment que d'habitude ?\n• Y a-t-il du sang dans les urines ?\n• Avez-vous de la fièvre ou des douleurs dans le bas du dos ?\n\n**Conseils immédiats :**\n• Buvez beaucoup d'eau (au moins 2L/jour) pour nettoyer les voies urinaires\n• **Urinaire** (médicament disponible en pharmacie) peut soulager\n• Évitez le café, l'alcool et les boissons gazeuses\n• Urinaire après chaque rapport sexuel (prévention)\n\n**Important :** Une infection urinaire non traitée peut remonter aux reins (pyélonéphrite — urgence). Consultez un médecin pour un antibiotique adapté.\n\nJe peux vous trouver un **médecin** ou une **pharmacie** proche.`

  // ── Fatigue / weakness ────────────────────────────────────────────────────
  if (/fatigue|fatigué|faiblesse|épuisé|manque d'énergie|asthénie|sans force/.test(m))
    return `La fatigue peut avoir de nombreuses causes. Pour vous aider :\n\n**Précisez :**\n• Depuis combien de temps ressentez-vous cette fatigue ?\n• Avez-vous aussi de la fièvre, perte de poids, sueurs nocturnes ?\n• Dormez-vous suffisamment (7-8h) ?\n• Avez-vous une alimentation équilibrée ?\n• Prenez-vous des médicaments ?\n\n**Causes fréquentes en Côte d'Ivoire :**\n• Anémie (manque de fer) — très fréquente\n• Paludisme — toujours y penser si fièvre associée\n• Hypothyroïdie\n• Carence en vitamines D et B12\n• Stress / surmenage\n\n**Conseils :**\n• Faites une prise de sang pour identifier la cause\n• Mangez équilibré avec des protéines et légumes verts\n• Hydratez-vous bien\n\nJe peux vous aider à prendre un **rendez-vous médecin** pour un bilan sanguin.`

  // ── Sleep problems ────────────────────────────────────────────────────────
  if (/insomnie|dormir|sommeil|nuit|réveill|se lever la nuit|cauchemar/.test(m))
    return `Les troubles du sommeil affectent beaucoup de personnes. Quelques conseils :\n\n**Hygiène du sommeil :**\n• Couchez-vous et réveillez-vous à heures fixes\n• Évitez les écrans 1h avant le coucher\n• Gardez la chambre fraîche et sombre\n• Pas de café ou thé après 16h\n• Exercice physique en journée (pas le soir)\n\n**Remèdes naturels :**\n• Tisane de valériane ou de mélisse (calmantes)\n• Magnésium (disponible en pharmacie)\n\n**Si l'insomnie dure plus de 2 semaines :** consultez un médecin — cela peut cacher anxiété, dépression, ou apnée du sommeil.\n\nDepuis combien de temps avez-vous ce problème et y a-t-il des événements stressants en ce moment ?`

  // ── Anxiety / stress ──────────────────────────────────────────────────────
  if (/anxiété|anxieux|stress|stressé|angoisse|panique|nerveux|peur|inquiet/.test(m))
    return `Je comprends, l'anxiété peut être très difficile à vivre. Quelques questions :\n\n**Précisez :**\n• Ressentez-vous des palpitations, transpiration, tremblements ?\n• Y a-t-il une situation particulière qui déclenche l'anxiété ?\n• Depuis combien de temps cela dure-t-il ?\n• Avez-vous déjà vécu des crises de panique ?\n\n**Techniques immédiates :**\n• **Respiration 4-7-8** : inspirez 4s, retenez 7s, expirez 8s\n• Posez les pieds à plat sur le sol, nommez 5 choses que vous voyez\n• Buvez un verre d'eau fraîche\n• Marchez 10 minutes à l'extérieur\n\n**À long terme :**\n• Activité physique régulière (excellente contre l'anxiété)\n• Méditation ou yoga\n• Limitez la caféine et l'alcool\n\nSi l'anxiété vous empêche de vivre normalement, parler à un médecin ou psychologue peut vraiment aider. Je peux vous aider à prendre un **rendez-vous**.`

  // ── Child / pediatric ─────────────────────────────────────────────────────
  if (/bébé|nourrisson|enfant|fils|fille|mon petit|ma petite|(ans|mois).*(enfant|bébé)/.test(m))
    return `La santé des enfants demande une attention particulière. Quelques questions :\n\n**Quel âge a l'enfant ?**\n\n**Symptômes à préciser :**\n• Fièvre ? Si oui, quelle température ?\n• L'enfant mange-t-il / boit-il normalement ?\n• A-t-il des vomissements, diarrhées, éruptions ?\n• Comment est-il : actif ou très abattu ?\n\n**Signaux d'alarme — consultez immédiatement si :**\n• Fièvre > 38°C chez nourrisson de moins de 3 mois\n• Fièvre > 39°C qui ne cède pas après paracétamol\n• Convulsions (même brèves)\n• Difficultés à respirer\n• Refus total de boire/manger\n• Fontanelle bombée chez le nourrisson\n\n**SAMU : 185** en cas d'urgence. Je peux vous trouver un **pédiatre** ou une **clinique pédiatrique** proche.`

  // ── Malaria (improved) ────────────────────────────────────────────────────
  if (/paludisme|malaria|palu/.test(m))
    return `Le paludisme est une priorité médicale en Côte d'Ivoire.\n\n**Symptômes classiques :**\n• Fièvre élevée avec frissons et sueurs\n• Maux de tête intenses\n• Douleurs musculaires\n• Nausées ou vomissements\n\n**Action immédiate :**\n1. Faites un **Test de Diagnostic Rapide (TDR)** — disponible en pharmacie, résultat en 15 min\n2. Si positif : consultez un médecin pour prescription (Coartem®, Artesunate)\n3. Ne prenez pas d'antipaludéen sans test préalable\n4. Buvez beaucoup d'eau, prenez du paracétamol pour la fièvre\n\n**Prévention :**\n• Moustiquaire imprégnée chaque nuit\n• Répulsif sur la peau\n• Vêtements longs le soir\n\n**Urgence si :** fièvre très élevée (>40°C), confusion, perte de connaissance → **SAMU 185**\n\nJe peux vous localiser la **pharmacie la plus proche** pour le TDR.`

  // ── Fever (improved) ─────────────────────────────────────────────────────
  if (/fièvre|température|chaud|thermomètre/.test(m))
    return `La fièvre signale que votre corps combat quelque chose. Précisons la situation :\n\n**Quelques questions :**\n• Quelle température avez-vous pris (si possible) ?\n• Depuis combien de temps la fièvre est-elle présente ?\n• Y a-t-il d'autres symptômes : frissons, sueurs, maux de tête, douleurs ?\n• Avez-vous voyagé ou été en contact avec des personnes malades ?\n\n**Que faire :**\n• **Paracétamol 500mg** ou 1g toutes les 6h si T° > 38,5°C\n• Buvez abondamment (2L d'eau minimum)\n• Restez au frais, vêtements légers\n• Surveillez la température toutes les 3-4h\n\n**En Côte d'Ivoire, toujours penser au paludisme** si fièvre avec frissons → faites un TDR.\n\n**Consultez si :** T° > 39,5°C malgré traitement, fièvre qui dure > 2 jours, confusion, raideur de la nuque.`

  // ── Diabetes (improved) ───────────────────────────────────────────────────
  if (/diabète|glycémie|insuline|sucre.*(sang|élevé|bas)/.test(m))
    return `La gestion du diabète est essentielle au quotidien. Comment puis-je vous aider ?\n\n**Si vous avez des symptômes actuels :**\n• Tremblement, transpiration, faim intense, confusion → **hypoglycémie** : prenez du sucre immédiatement (jus de fruit, sucre)\n• Soif intense, urines fréquentes, fatigue → **hyperglycémie** : consultez votre médecin\n\n**Conseils généraux :**\n• Prenez votre traitement (**Metformine**, insuline) sans interruption, même si vous vous sentez bien\n• Alimentation : réduisez sucres rapides, riz blanc, pain blanc, boissons sucrées\n• Activité physique 30 min/jour minimum\n• Contrôlez votre glycémie régulièrement\n• Consultation médicale tous les 3 mois\n\nJe peux vous aider à **commander vos médicaments** ou à prendre un **rendez-vous diabétologue**.`

  // ── Hypertension (improved) ───────────────────────────────────────────────
  if (/tension|hypertension|pression.*(artérielle|sang)|cardio/.test(m))
    return `L'hypertension artérielle est fréquente et souvent silencieuse. Quelques précisions :\n\n**Avez-vous pris votre tension ?** Si oui, quelle valeur ?\n\n**Règles d'or :**\n• Prenez votre traitement **tous les jours** sans oublier — ne jamais arrêter brusquement\n• Réduisez le sel (max 5g/jour), évitez les plats très salés\n• Arrêtez tabac et alcool\n• Perdez du poids si en surpoids\n• Exercice modéré régulier (marche 30 min/jour)\n\n**Mesurez votre tension régulièrement** — idéalement le matin et le soir.\n\n**Consultez en urgence si :** tension > 180/110 avec maux de tête violents, vision floue, douleur thoracique → risque d'AVC.\n\nNos pharmacies partenaires peuvent mesurer votre tension. Voulez-vous que je vous en trouve une ?`

  // ── Wound / injury ────────────────────────────────────────────────────────
  if (/blessure|plaie|coupure|saignement|sang|brûlure|entorse|fracture|chute/.test(m))
    return `Pour une blessure, voici les premiers gestes :\n\n**Plaie / coupure :**\n1. Rincez abondamment à l'eau propre pendant 5 min\n2. Appuyez avec un tissu propre pour arrêter le saignement\n3. Désinfectez avec de la **Bétadine** ou de l'alcool à 70°\n4. Couvrez avec un pansement propre\n\n**Brûlure :**\n1. Eau froide (pas glacée) pendant 15 min minimum\n2. Ne percez pas les cloques\n3. Pansement non adhérent\n4. Si surface > paume de main ou brûlure profonde : urgences\n\n**Consultez si :** saignement qui ne s'arrête pas après 10 min, plaie profonde ou large, corps étranger, signe d'infection (rouge, chaud, pus), vaccin antitétanique non à jour.\n\nSaignement abondant qui ne s'arrête pas → **SAMU 185**`

  // ── Diarrhea (improved) ───────────────────────────────────────────────────
  if (/diarrhée|selles|intestin|gastro|vomissement|nausée/.test(m))
    return `Les troubles digestifs sont fréquents. Pour mieux vous aider :\n\n**Précisez :**\n• Depuis combien de temps ?\n• Combien de fois par jour (vomissements / diarrhées) ?\n• Y a-t-il du sang dans les selles ?\n• Avez-vous de la fièvre ?\n• Qu'avez-vous mangé ces 24 dernières heures ?\n\n**Réhydratation — priorité absolue :**\n• Préparez des **SRO** (Sels de Réhydratation Orale) : sachet + eau propre\n• Buvez par petites gorgées toutes les 5 min\n• En l'absence de SRO : eau + 1 c. à café sel + 8 c. à café sucre\n• Évitez lait, café, alcool, aliments gras\n\n**Alimentation légère :** riz blanc, banane, pain grillé, soupe claire\n\n**Consultez si :** sang dans les selles, fièvre élevée, diarrhée > 3 jours, impossibilité de boire (déshydratation sévère), chez enfant ou personne âgée.`

  // ── Pregnancy ─────────────────────────────────────────────────────────────
  if (/grossesse|enceinte|bébé.*(enceinte|grossesse)|accouche|enceinte|trimestre/.test(m))
    return `La santé maternelle est une priorité. Comment puis-je vous aider ?\n\n**Consultations prénatales recommandées :**\n• 1er trimestre (avant 12 semaines) : 1ère consultation, prise de sang, écho\n• 2e trimestre (20-24 semaines) : écho morphologique\n• 3e trimestre (32-34 semaines) + avant accouchement\n\n**Supplémentations essentielles :**\n• **Acide folique** (dès avant la grossesse et 1er trim.) — prévient malformations\n• **Fer + Folate** tout au long de la grossesse\n• **Vaccin tétanique** obligatoire\n\n**Signaux d'alarme :** saignements, douleurs abdominales intenses, contractions avant 37 semaines, bébé qui ne bouge plus → urgence gynécologique.\n\nJe peux vous aider à trouver une **clinique partenaire** ou un **gynécologue**.`

  // ── Vaccination ───────────────────────────────────────────────────────────
  if (/vaccin|vaccination|immunisation/.test(m))
    return `La vaccination est essentielle pour se protéger.\n\n**Vaccins obligatoires en Côte d'Ivoire :**\n• Fièvre jaune (carnet international requis)\n\n**Vaccins fortement recommandés :**\n• Hépatite A et B\n• Typhoïde\n• Méningite (ACW135Y)\n• Tétanos-Diphtérie-Coqueluche (rappel adulte)\n• COVID-19\n• Poliomyélite (rappel)\n\n**Pour les enfants :** calendrier PEV (Programme Élargi de Vaccination) — BCG, DTC, Polio, Rougeole...\n\nConsultez le centre de vaccination le plus proche. Je peux vous trouver une **clinique partenaire** pour la vaccination.`

  // ── Medication order intent ───────────────────────────────────────────────
  if (/commande|commander|livrer|acheter|avoir.*(médicament|comprimé|sirop)/.test(m))
    return `Je peux vous aider à commander vos médicaments via MedMap+.\n\n**Comment ça marche :**\n1. Rendez-vous dans la section **Médicaments** de l'app\n2. Cherchez votre médicament ou scannez votre ordonnance\n3. Choisissez la pharmacie partenaire la plus proche\n4. Payez via votre **portefeuille MedMap+**\n5. Recevez une notification quand c'est prêt\n\n**Médicaments que vous souhaitez commander ?** Précisez le nom et je vous guide.\n\n⚠️ Les médicaments sur ordonnance nécessitent une prescription médicale valide.`

  // ── Appointment intent ────────────────────────────────────────────────────
  if (/rendez-vous|rdv|consulter|consultation|docteur|médecin|spécialiste|gynéco|cardio|dermato|ophtalmo|pédiatre|généraliste/.test(m))
    return `Je peux vous aider à prendre un rendez-vous médical sur MedMap+.\n\n**Spécialités disponibles :**\n• Médecin généraliste\n• Pédiatrie (enfants)\n• Gynécologie\n• Cardiologie\n• Dermatologie\n• Ophtalmologie\n• Et plus encore...\n\n**Comment prendre un RDV :**\n1. Rendez-vous dans la section **Rendez-vous**\n2. Choisissez la spécialité et un médecin\n3. Sélectionnez un créneau disponible\n4. Payez via votre portefeuille\n5. Recevez un ticket électronique\n\nQuelle spécialité recherchez-vous ?`

  // ── Pharmacy / medication info ────────────────────────────────────────────
  if (/pharmacie|paracétamol|ibuprofène|aspirine|amoxicilline|antibiotique|médicament|ordonnance/.test(m))
    return `Pour vos médicaments, voici ce que MedMap+ peut faire :\n\n• **Trouver une pharmacie de garde** ouverte 24h/24 proche de vous\n• **Commander en ligne** avec livraison à domicile\n• **Analyser votre ordonnance** (importez une photo)\n\n**Médicaments courants disponibles sans ordonnance :**\n• Douleurs/fièvre : Paracétamol, Ibuprofène\n• Estomac : Spasfon, Gaviscon, Imodium\n• Allergie : Cétirizine (Zyrtec)\n• Gorge : pastilles antiseptiques\n• Yeux : Visine, Opticrom\n\n⚠️ Antibiotiques, antipaludéens, et autres médicaments sur ordonnance nécessitent une prescription médicale.\n\nQuel médicament cherchez-vous ?`

  // ── Default smart response ────────────────────────────────────────────────
  return `Je suis MediA, votre assistante santé MedMap+.\n\nPourriez-vous me décrire plus précisément votre situation ? Par exemple :\n• Quels sont vos symptômes ?\n• Depuis quand ?\n• Avez-vous de la fièvre ?\n\nJe peux vous aider avec des conseils médicaux, vous trouver un médecin ou une pharmacie, ou gérer une urgence. Dites-moi comment je peux vous aider.\n\n⚠️ Mes conseils sont informatifs et ne remplacent pas une consultation médicale professionnelle.`
}

// ── Prescription image analysis ───────────────────────────────────────────────
async function analyzePrescription(base64Image, mimeType = 'image/jpeg') {
  if (!process.env.GEMINI_API_KEY) {
    return 'Pour analyser cette ordonnance, configurez la clé GEMINI_API_KEY dans le fichier .env du backend.\n\nEn attendant, présentez votre ordonnance directement à un pharmacien partenaire MedMap+ qui pourra vous conseiller et préparer vos médicaments.'
  }
  const { GoogleGenerativeAI } = require('@google/generative-ai')
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })
  const prompt = `Analyse cette ordonnance médicale et fournis de façon structurée :\n\n**Médicaments prescrits :**\n(liste chaque médicament avec dosage, fréquence et durée)\n\n**Conseils de prise importants :**\n(à prendre pendant ou après les repas, éviter alcool, etc.)\n\n**Points de vigilance :**\n(effets secondaires courants, interactions à connaître)\n\n**Résumé du traitement :**\n(explication simple pour le patient)\n\nRéponds en français, de façon claire. Rappelle à la fin que cette analyse est informative et que le pharmacien reste le référent pour la dispensation.`
  const result = await model.generateContent([prompt, { inlineData: { data: base64Image, mimeType } }])
  return result.response.text()
}

// ── POST /chat/message ────────────────────────────────────────────────────────
router.post('/message', requireAuth, async (req, res) => {
  const { message } = req.body
  if (!message?.trim()) return res.status(422).json({ detail: 'Message requis' })

  try {
    const sub = await getOrCreateSubscription(req.user.id)
    const isPremium = sub.plan === 'premium'
    const used = sub.messages_used || 0

    if (!isPremium && used >= BASIC_LIMIT) {
      return res.status(403).json({ detail: 'Limite MediA Basic atteinte', is_premium: false, messages_left: 0, limit_reached: true })
    }

    const userCtx = `${req.user.prenom} ${req.user.nom} (${req.user.role})`
    const history = await getHistory(req.user.id)
    const reply = await getAIResponse(message.trim(), userCtx, history)

    await pool.query('INSERT INTO chat_messages (user_id, message, response) VALUES (?, ?, ?)', [req.user.id, message.trim(), reply])
    await pool.query('UPDATE subscriptions SET messages_used = messages_used + 1 WHERE user_id = ?', [req.user.id])

    const messagesLeft = isPremium ? null : Math.max(0, BASIC_LIMIT - used - 1)
    const io = req.app.get('io')
    if (io) io.to(`user_${req.user.id}`).emit('chat:response', { message: message.trim(), reply })

    res.json({ reply, message: message.trim(), is_premium: isPremium, messages_left: messagesLeft, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('[Chat]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /chat/transcribe ─────────────────────────────────────────────────────
// Transcribes audio via Gemini 1.5 (no dependency on Chrome's Google STT)
router.post('/transcribe', requireAuth, async (req, res) => {
  const { audio, mimeType = 'audio/webm' } = req.body
  if (!audio) return res.status(422).json({ error: 'Audio requis (base64)' })
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'Clé Gemini non configurée', transcript: null })
  }
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai')
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })
    const result = await model.generateContent([
      { inlineData: { data: audio, mimeType } },
      'Transcris exactement ce que tu entends dans cet audio en français. Retourne UNIQUEMENT le texte transcrit, sans aucun commentaire ni ponctuation superflue.',
    ])
    const transcript = result.response.text().trim()
    res.json({ transcript })
  } catch (err) {
    console.error('[Transcribe]', err.message)
    res.status(500).json({ error: 'Erreur transcription', transcript: null })
  }
})

// ── POST /chat/analyze-prescription ──────────────────────────────────────────
router.post('/analyze-prescription', requireAuth, async (req, res) => {
  const { image, mimeType } = req.body
  if (!image) return res.status(422).json({ detail: 'Image requise (base64)' })
  try {
    const analysis = await analyzePrescription(image, mimeType)
    await pool.query('INSERT INTO chat_messages (user_id, message, response) VALUES (?, ?, ?)', [req.user.id, '[Analyse ordonnance]', analysis])
    res.json({ analysis })
  } catch (err) {
    console.error('[Prescription]', err.message)
    res.status(500).json({ analysis: 'Impossible d\'analyser l\'ordonnance. Consultez directement un pharmacien.' })
  }
})

// ── GET /chat/history ─────────────────────────────────────────────────────────
router.get('/history', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id])
    res.json(rows.reverse())
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
