/* Ligação com o Firebase (Authentication + Firestore). É a única parte que conhece o Firebase.
   Tudo o que o jogo grava como "mensagem" vai como texto JSON, porque o Firestore
   não aceita listas dentro de listas (o mapa tem). */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica;
  else raiz.criarNuvem = fabrica;
})(typeof self !== "undefined" ? self : this, function criarNuvem(firebase, config) {
  "use strict";
  const DOMINIO = "@detetive.app";
  const RE_USUARIO = /^[A-Za-z0-9_]{3,20}$/;
  const RE_APELIDO = /^[\p{L}\p{N}_][\p{L}\p{N}_ .'-]{0,14}[\p{L}\p{N}_]$/u;

  const app = firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(config);
  const auth = firebase.auth(), db = firebase.firestore();
  try { db.settings({ experimentalAutoDetectLongPolling: true, merge: true }); } catch (e) { /* já configurado */ }
  const agora = () => firebase.firestore.FieldValue.serverTimestamp();
  const sala = c => db.collection("salas").doc(c);

  function traduz(e) {
    const c = (e && e.code) || "";
    if (c === "auth/email-already-in-use") return "Esse usuário já existe. Escolha outro.";
    if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return "Usuário ou senha incorretos.";
    if (c === "auth/too-many-requests") return "Muitas tentativas. Tente de novo em instantes.";
    if (c === "auth/network-request-failed") return "Sem conexão com a internet.";
    if (c === "auth/operation-not-allowed" || c === "auth/admin-restricted-operation") return "Esse tipo de login ainda não foi ativado no Firebase (veja o LEIA-ME).";
    if (c === "auth/weak-password") return "A senha precisa ter de 6 a 72 caracteres.";
    if (c === "permission-denied") return "O Firebase recusou o pedido. Confira as regras (veja o LEIA-ME).";
    return "Não foi possível concluir. Tente de novo.";
  }
  const erroLegivel = e => (e && e.legivel) ? e : Object.assign(new Error(traduz(e)), { legivel: true });
  const falha = m => Object.assign(new Error(m), { legivel: true });
  const mapa = u => u && { uid: u.uid, nome: u.displayName || null, convidado: u.isAnonymous };
  const ms = t => (t && t.toMillis ? t.toMillis() : null);

  return {
    traduz,
    /* ----------------------------------------------------------- contas */
    aoMudarUsuario(cb) { return auth.onAuthStateChanged(u => cb(mapa(u))); },
    usuarioAtual() { return mapa(auth.currentUser); },
    async registrar(usuario, senha) {
      if (!RE_USUARIO.test(usuario || "")) throw falha("Usuário: 3 a 20 letras, números ou _ (sem espaços).");
      if (typeof senha !== "string" || senha.length < 6 || senha.length > 72) throw falha("A senha precisa ter de 6 a 72 caracteres.");
      try {
        const r = await auth.createUserWithEmailAndPassword(usuario.toLowerCase() + DOMINIO, senha);
        await r.user.updateProfile({ displayName: usuario });
        return mapa(auth.currentUser);
      } catch (e) { throw erroLegivel(e); }
    },
    async entrar(usuario, senha) {
      if (!RE_USUARIO.test(usuario || "") || !senha) throw falha("Usuário ou senha incorretos.");
      try {
        const r = await auth.signInWithEmailAndPassword(usuario.toLowerCase() + DOMINIO, senha);
        return mapa(r.user);
      } catch (e) { throw erroLegivel(e); }
    },
    async convidado(apelido) {
      apelido = (apelido || "").trim();
      if (!RE_APELIDO.test(apelido)) throw falha("Apelido: 2 a 16 letras, números ou espaços.");
      try {
        const r = await auth.signInAnonymously();
        await r.user.updateProfile({ displayName: apelido });
        return mapa(auth.currentUser);
      } catch (e) { throw erroLegivel(e); }
    },
    async sair() { await auth.signOut(); },

    /* ------------------------------------------------------------ salas */
    async lerSala(codigo) {
      try { const d = await sala(codigo).get(); return d.exists ? d.data() : null; } catch (e) { throw erroLegivel(e); }
    },
    async criarSala(codigo, uidAnfitriao) {
      try { await sala(codigo).set({ hostUid: uidAnfitriao, criada: agora(), juizVisto: agora() }); } catch (e) { throw erroLegivel(e); }
    },
    /* Assume o lugar do juiz quando o anfitrião sumiu (as regras só deixam depois de 60 s sem sinal). */
    async assumirSala(codigo, uid) {
      try { await sala(codigo).update({ hostUid: uid, juizVisto: agora() }); }
      catch (e) { if (e && e.code === "permission-denied") throw falha("Ainda não dá para assumir: o anfitrião pode ter voltado. Tente de novo em instantes."); throw erroLegivel(e); }
    },
    baterJuiz(codigo) { return sala(codigo).update({ juizVisto: agora() }).catch(() => {}); },
    escutarSala(codigo, cb) {
      return sala(codigo).onSnapshot(d => cb(d.exists ? { ...d.data(), juizVistoMs: ms(d.data().juizVisto) } : null), () => { /* erro passageiro: ignora */ });
    },
    async apagarSala(codigo, uids) {
      const s = sala(codigo);
      try {
        const cmds = await s.collection("comandos").get();
        await Promise.all([
          ...cmds.docs.map(d => d.ref.delete()),
          ...uids.map(u => s.collection("saidas").doc(u).delete()),
          ...uids.map(u => s.collection("presenca").doc(u).delete()),
          s.collection("segredo").doc("estado").delete(),
        ]);
        await s.delete();
      } catch (e) { /* limpeza é só uma gentileza */ }
    },

    /* ------------------------------------------------- juiz (anfitrião) */
    salvarEstado(codigo, obj) { return sala(codigo).collection("segredo").doc("estado").set({ json: JSON.stringify(obj) }).catch(() => {}); },
    async lerEstado(codigo) {
      const d = await sala(codigo).collection("segredo").doc("estado").get();
      return d.exists ? JSON.parse(d.data().json) : null;
    },
    escutarComandos(codigo, cb) {
      return sala(codigo).collection("comandos").orderBy("t").onSnapshot(snap => {
        snap.docChanges().filter(c => c.type === "added").forEach(c => {
          const d = c.doc.data(); let msg = null;
          try { msg = JSON.parse(d.msg); } catch (e) { /* ignora lixo */ }
          cb({ id: c.doc.id, uid: d.uid, nome: d.nome, msg });
        });
      });
    },
    apagarComando(codigo, id) { return sala(codigo).collection("comandos").doc(id).delete().catch(() => {}); },
    escutarPresenca(codigo, cb) {
      let primeira = true;
      return sala(codigo).collection("presenca").onSnapshot(snap => {
        snap.docChanges().forEach(c => { if (c.type !== "removed") cb(c.doc.id, ms(c.doc.data().t), primeira, c.doc.data().token || ""); });
        primeira = false;
      });
    },
    escreverSaida(codigo, uid, msg) {
      return sala(codigo).collection("saidas").doc(uid).set({ [msg.tipo]: JSON.stringify(msg) }, { merge: true }).catch(() => {});
    },

    /* ---------------------------------------------------- jogador comum */
    enviarComando(codigo, uid, nome, msg) {
      return sala(codigo).collection("comandos").add({ uid, nome, msg: JSON.stringify(msg), t: agora() }).catch(e => { throw erroLegivel(e); });
    },
    escutarSaida(codigo, uid, cb) {
      return sala(codigo).collection("saidas").doc(uid).onSnapshot(d => {
        const out = {};
        if (!d.exists) return cb(out);
        for (const [k, v] of Object.entries(d.data())) { try { out[k] = JSON.parse(v); } catch (e) { /* ignora */ } }
        cb(out);
      });
    },
    presenca(codigo, uid, token) { return sala(codigo).collection("presenca").doc(uid).set(token ? { t: agora(), token: String(token).slice(0, 400) } : { t: agora() }).catch(() => {}); },

    /* ------------------------------------------------------- histórico */
    registrarPartida(uid, codigo, dados) {
      return db.collection("usuarios").doc(uid).collection("partidas").doc(codigo).set({ ...dados, quando: agora() }).catch(() => {});
    },
    async historico(uid) {
      try {
        const q = await db.collection("usuarios").doc(uid).collection("partidas").orderBy("quando", "desc").limit(200).get();
        return q.docs.map(d => { const x = d.data(); return { sala: d.id.split("-")[0], jogadores: x.jogadores, venceu: !!x.venceu, quando: ms(x.quando), palpites: x.palpites || 0, rodadas: x.rodadas || 0, acusou: !!x.acusou }; });
      } catch (e) { throw erroLegivel(e); }
    },
  };
});
