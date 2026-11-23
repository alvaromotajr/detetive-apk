/* Cola entre a tela, o juiz e a nuvem.
   A tela fala com o transporte como se fosse um servidor: `enviar(msg)` e `aoReceber(msg)`.
   - Anfitrião: os comandos vão direto ao juiz (neste celular) e as respostas aos outros vão para o Firestore.
   - Outros jogadores: comandos vão para o Firestore e as respostas chegam pela caixa de saída. */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica;
  else raiz.criarTransporte = fabrica;
})(typeof self !== "undefined" ? self : this, function criarTransporte(o) {
  "use strict";
  const { nuvem, Juiz, aoReceber } = o;
  const relogio = o.relogio || (() => Date.now());
  const agenda = o.agenda || { cada: (f, ms) => { const i = setInterval(f, ms); return () => clearInterval(i); }, depois: (f, ms) => { const i = setTimeout(f, ms); return () => clearTimeout(i); } };
  const guardado = o.armazenar || { ler: () => null, gravar: () => {}, apagar: () => {} };
  const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const sorteio = o.sorteio || (n => { const b = new Uint32Array(1); const lim = Math.floor(4294967296 / n) * n; do { crypto.getRandomValues(b); } while (b[0] >= lim); return b[0] % n; });
  const ONLINE_JUIZ = 75000;

  const MAX_SALAS = 3;
  let eu = null, contErro = 0, jaRegistradas = new Set();
  const salas = new Map();
  const pend = new Set();
  const acompanha = p => { const x = Promise.resolve(p).catch(() => {}).then(() => pend.delete(x)); pend.add(x); return x; };
  const emit = m => { try { aoReceber(m); } catch (e) { if (typeof console !== "undefined") console.error(e); } };
  const erroMsg = texto => emit({ tipo: "erro", mensagem: texto, n: ++contErro });
  const legivel = e => (e && e.legivel ? e.message : "Algo deu errado. Tente de novo.");

  /* ---------------------------------------------------------------- contas */
  async function autenticar(u) {
    if (!u || !u.nome) return;                       // login ainda a meio caminho
    if (eu && eu.uid === u.uid && eu.nome === u.nome) return;
    eu = u;
    emit({ tipo: "autenticado", token: "", nome: u.nome, convidado: u.convidado });
    await retomar();
  }
  async function deslogou() {
    await desligarTodas(true);
    eu = null; emit({ tipo: "deslogado" });
  }
  function iniciar() {
    return nuvem.aoMudarUsuario(u => { (u === null ? deslogou() : autenticar(u)).catch(() => {}); });
  }

  /* ----------------------------------------------------------------- salas
     O jogador pode estar em até MAX_SALAS salas ao mesmo tempo. Cada sala tem seu próprio estado
     (`salas.get(codigo)`) e toda mensagem enviada à tela leva `__sala` com o código. */
  function entregar(codigo, uid, msg) {
    if (eu && uid === eu.uid) entregarLocal(codigo, msg); else acompanha(nuvem.escreverSaida(codigo, uid, msg));
  }
  function emitSala(codigo, msg) { emit({ ...msg, __sala: codigo }); }
  function entregarLocal(codigo, msg) {
    const sala = salas.get(codigo);
    if (msg.tipo === "sala" && sala) { sala.entrando = false; sala.cancelaEspera && sala.cancelaEspera(); }
    if (msg.tipo === "jogo" && sala && msg.visao.fase === "fim" && !jaRegistradas.has(codigo + ":" + JSON.stringify(msg.visao.solucao)) && eu && !eu.convidado) {
      jaRegistradas.add(codigo + ":" + JSON.stringify(msg.visao.solucao));
      const v = msg.visao, ev = v.eventos || [], meu = e => e.jogador === v.voce;
      nuvem.registrarPartida(eu.uid, codigo + "-" + (v.solucao ? v.solucao.length : 0) + ev.length, {
        venceu: v.vencedor === v.voce, jogadores: v.jogadores.length,
        palpites: ev.filter(e => e.tipo === "palpite" && meu(e)).length, rodadas: ev.filter(e => e.tipo === "vez_de").length,
        acusou: ev.some(e => (e.tipo === "acusacao_certa" || e.tipo === "acusacao_errada") && meu(e)), solucao: v.solucao || null,
      });
    }
    if (msg.tipo === "saiu_da_sala") { desligarSala(sala, false).then(() => emitSala(codigo, msg)); return; }
    emitSala(codigo, msg);
    if (msg.tipo === "erro" && sala && sala.entrando) desligarSala(sala, false);
  }

  function guardarLista() {
    const lista = [...salas.values()].map(s => ({ codigo: s.codigo, host: s.host }));
    if (lista.length) guardado.gravar("detetive_salas", JSON.stringify(lista)); else guardado.apagar("detetive_salas");
    guardado.apagar("detetive_sala");                     // formato antigo (uma sala só)
  }
  function novaSala(codigo, host) {
    const s = { codigo, host, juiz: null, entrando: !host, unsubs: [], timers: [], ultimaMudanca: relogio(), juizOffline: false, uids: new Set(), todos: new Set(), cancelaEspera: null };
    salas.set(codigo, s); guardarLista();
    return s;
  }
  async function desligarSala(s, encerrarComoJuiz) {
    if (!s || salas.get(s.codigo) !== s) return;
    salas.delete(s.codigo); guardarLista();
    s.cancelaEspera && s.cancelaEspera();
    s.unsubs.forEach(f => { try { f(); } catch (e) { /* ok */ } }); s.timers.forEach(f => f());
    if (s.host && s.juiz && !s.juiz.encerrada && encerrarComoJuiz) s.juiz.encerrar("O anfitrião saiu.");
    emitSala(s.codigo, { tipo: "juiz_offline", offline: false });
  }
  async function desligarTodas(encerrarComoJuiz) { for (const s of [...salas.values()]) await desligarSala(s, encerrarComoJuiz); }

  function opcoesJuiz(codigo) {
    const s0 = salas.get(codigo);
    let ocupado = false, pendente = null;
    const salvar = async obj => {
      pendente = obj; if (ocupado) return; ocupado = true;
      while (pendente) { const x = pendente; pendente = null; await nuvem.salvarEstado(codigo, x); }
      ocupado = false;
    };
    return {
      relogio, enviar: (uid, m) => entregar(codigo, uid, m), salvar, agenda: (f, ms) => agenda.depois(f, ms),
      aoEncerrar: (motivo, uids) => { const todos = [...new Set([...(s0 ? s0.todos : []), ...(uids || [])])]; agenda.depois(() => nuvem.apagarSala(codigo, todos), 15000); },
    };
  }
  function ligarJuiz(codigo, juiz) {
    const s = salas.get(codigo);
    s.juiz = juiz;
    juiz.membros.forEach(m => { if (!m.bot) { s.uids.add(m.uid); s.todos.add(m.uid); } });
    s.unsubs.push(nuvem.escutarComandos(codigo, async c => {
      if (c.msg && c.uid) { s.uids.add(c.uid); s.todos.add(c.uid); juiz.receber(c.uid, c.nome, c.msg); }
      await nuvem.apagarComando(codigo, c.id);
    }));
    s.unsubs.push(nuvem.escutarPresenca(codigo, (uid, t, primeira) => {
      if (primeira && t != null && relogio() - t > 45000) return;
      juiz.presenca(uid);
    }));
    s.unsubs.push(nuvem.escutarSala(codigo, d => {      // outro jogador assumiu: volto a ser jogador comum
      if (d && d.hostUid && d.hostUid !== eu.uid && salas.get(codigo) === s && s.host) perdeuJuiz(s);
    }));
    s.timers.push(agenda.cada(() => juiz.tick(), 5000));
    s.timers.push(agenda.cada(() => nuvem.baterJuiz(codigo), 20000));
  }
  async function perdeuJuiz(antiga) {
    const codigo = antiga.codigo;
    await desligarSala(antiga, false);
    emitSala(codigo, { tipo: "erro", mensagem: "Outro jogador assumiu a partida. Você continua jogando.", n: ++contErro });
    const s = novaSala(codigo, false);
    ligarCliente(codigo); esperarResposta(s);
    await nuvem.enviarComando(codigo, eu.uid, eu.nome, { tipo: "entrar_sala" });
  }
  /* O anfitrião sumiu: quem estiver na sala pode continuar de onde parou. */
  async function assumirPartida(s) {
    if (!s || s.host) return;
    const codigo = s.codigo;
    if (!s.juizOffline) throw Object.assign(new Error("O anfitrião ainda está por aqui."), { legivel: true });
    await nuvem.assumirSala(codigo, eu.uid);
    const estado = await nuvem.lerEstado(codigo).catch(() => null);
    if (!estado) throw Object.assign(new Error("Não achei a partida salva. Peça para o anfitrião voltar."), { legivel: true });
    await desligarSala(s, false);
    novaSala(codigo, true);
    const juiz = Juiz.restaurar(estado, opcoesJuiz(codigo));
    ligarJuiz(codigo, juiz);
    juiz.transferir(eu.uid, eu.nome);
  }
  function ligarCliente(codigo) {
    const s = salas.get(codigo), ultimo = {}; let primeira = true;
    s.unsubs.push(nuvem.escutarSaida(codigo, eu.uid, out => {
      s.ultimaSaida = (s.ultimaSaida || 0) + 1;
      const ordem = ["sala", "jogo", "caderno", "erro", "cutucada", "saiu_da_sala"];
      for (const tipo of ordem) {
        if (!out[tipo]) continue;
        const chave = JSON.stringify(out[tipo]);
        if (ultimo[tipo] === chave) continue;
        ultimo[tipo] = chave;
        if ((tipo === "erro" || tipo === "cutucada") && primeira) continue;      // aviso velho
        if (salas.get(codigo) !== s) return;
        entregarLocal(codigo, out[tipo]);
      }
      primeira = false;
    }));
    s.unsubs.push(nuvem.escutarSala(codigo, d => {
      s.ultimaMudanca = relogio();
      if (d === null && salas.get(codigo) === s && !s.entrando) entregarLocal(codigo, { tipo: "saiu_da_sala", motivo: "A sala foi encerrada." });
    }));
    s.timers.push(agenda.cada(() => nuvem.presenca(codigo, eu.uid), 20000));
    s.timers.push(agenda.cada(() => {
      const seg = Math.round((relogio() - s.ultimaMudanca) / 1000), off = seg * 1000 > ONLINE_JUIZ;
      if (off !== s.juizOffline || off) { s.juizOffline = off; emitSala(codigo, { tipo: "juiz_offline", offline: off, segundos: off ? seg : 0 }); }
    }, 10000));
    nuvem.presenca(codigo, eu.uid);
  }
  function esperarResposta(s) {
    s.cancelaEspera = agenda.depois(() => {
      if (salas.get(s.codigo) === s && s.entrando) { desligarSala(s, false); emitSala(s.codigo, { tipo: "erro", mensagem: "O anfitrião não respondeu. Ele precisa estar com o app aberto.", n: ++contErro }); }
    }, 12000);
  }

  const limiteSalas = () => { if (salas.size >= MAX_SALAS) throw Object.assign(new Error(`Você já está em ${MAX_SALAS} salas. Saia de uma delas para abrir outra.`), { legivel: true }); };
  async function criarSala() {
    limiteSalas();
    let codigo = null;
    for (let i = 0; i < 6 && !codigo; i++) {
      const c = Array.from({ length: 5 }, () => ALFABETO[sorteio(ALFABETO.length)]).join("");
      if (!salas.has(c) && !(await nuvem.lerSala(c))) codigo = c;
    }
    if (!codigo) throw new Error("sem código");
    await nuvem.criarSala(codigo, eu.uid);
    novaSala(codigo, true);
    const juiz = new Juiz({ ...opcoesJuiz(codigo), codigo, uidAnfitriao: eu.uid, nomeAnfitriao: eu.nome });
    ligarJuiz(codigo, juiz);
  }
  async function entrarSala(msg) {
    const codigo = String(msg.codigo || "").trim().toUpperCase();
    if (salas.has(codigo)) { emitSala(codigo, { tipo: "abrir_sala" }); return; }
    limiteSalas();
    if (!/^[A-Z]{3,8}$/.test(codigo)) throw Object.assign(new Error("Sala não encontrada. Confira o código."), { legivel: true });
    const d = await nuvem.lerSala(codigo);
    if (!d) throw Object.assign(new Error("Sala não encontrada. Confira o código."), { legivel: true });
    if (salas.has(codigo)) return;
    if (d.hostUid === eu.uid) { novaSala(codigo, true); await retomarJuiz(salas.get(codigo)); return; }
    const s = novaSala(codigo, false);
    ligarCliente(codigo); esperarResposta(s);
    await nuvem.enviarComando(codigo, eu.uid, eu.nome, { tipo: "entrar_sala" });
  }
  async function retomarJuiz(s) {
    const codigo = s.codigo, estado = await nuvem.lerEstado(codigo);
    if (!estado || estado.uidAnfitriao !== eu.uid) { await desligarSala(s, false); return; }
    const juiz = Juiz.restaurar(estado, opcoesJuiz(codigo));
    ligarJuiz(codigo, juiz); juiz.reenviarTudo();
  }
  let retomando = false;
  async function retomar() {
    if (!eu || retomando) return;
    retomando = true;
    try {
      let lista = []; try { lista = JSON.parse(guardado.ler("detetive_salas") || "null") || []; } catch (e) { /* ignora */ }
      if (!lista.length) { try { const antiga = JSON.parse(guardado.ler("detetive_sala") || "null"); if (antiga && antiga.codigo) lista = [antiga]; } catch (e) { /* ignora */ } }
      for (const salvo of lista.slice(0, MAX_SALAS)) {
        if (!salvo || !salvo.codigo || salas.has(salvo.codigo)) continue;
        const d = await nuvem.lerSala(salvo.codigo).catch(() => null);
        if (!d) continue;
        if (salas.has(salvo.codigo)) continue;
        if (d.hostUid === eu.uid) { novaSala(salvo.codigo, true); await retomarJuiz(salas.get(salvo.codigo)); continue; }
        const s = novaSala(salvo.codigo, false);
        ligarCliente(salvo.codigo); esperarResposta(s);
        await nuvem.enviarComando(salvo.codigo, eu.uid, eu.nome, { tipo: "entrar_sala" });
      }
      guardarLista();
      emit({ tipo: "retomado" });
    } finally { retomando = false; }
  }

  /* --------------------------------------------------------------- entrada */
  function acharSala(msg) {
    const c = msg._sala ? String(msg._sala).toUpperCase() : null;
    if (c) { const s = salas.get(c); if (!s) throw Object.assign(new Error("Você não está nessa sala."), { legivel: true }); return s; }
    if (salas.size === 1) return [...salas.values()][0];
    throw Object.assign(new Error("Você não está em uma sala."), { legivel: true });
  }
  async function comandoDeJogo(msg0) {
    const s = acharSala(msg0), msg = { ...msg0 }; delete msg._sala;
    if (s.host) { s.juiz.receber(eu.uid, eu.nome, msg); return; }
    const antes = s.ultimaSaida || 0;
    await nuvem.enviarComando(s.codigo, eu.uid, eu.nome, msg);
    if (!["sair_sala", "chat", "assumir", "cutucar"].includes(msg.tipo)) agenda.depois(() => {
      if (salas.get(s.codigo) === s && !s.entrando && (s.ultimaSaida || 0) === antes) emitSala(s.codigo, { tipo: "erro", mensagem: "O anfitrião ainda não respondeu. Se o app dele estiver fechado, a jogada fica esperando.", n: ++contErro });
    }, 10000);
    if (msg.tipo === "sair_sala") agenda.depois(() => { if (salas.get(s.codigo) === s) entregarLocal(s.codigo, { tipo: "saiu_da_sala" }); }, 4000);
  }
  async function tratar(msg) {
    if (!msg || typeof msg.tipo !== "string") throw Object.assign(new Error("Mensagem inválida."), { legivel: true });
    switch (msg.tipo) {
      case "registrar": return autenticar(await nuvem.registrar(msg.usuario, msg.senha));
      case "entrar": return autenticar(await nuvem.entrar(msg.usuario, msg.senha));
      case "convidado": return autenticar(await nuvem.convidado(msg.apelido));
      case "retomar": return retomar();
      case "assumir": return assumirPartida(acharSala(msg));
      case "sair_conta": {
        for (const s of [...salas.values()]) {
          if (!s.host) await nuvem.enviarComando(s.codigo, eu.uid, eu.nome, { tipo: "sair_sala" }).catch(() => {});
        }
        await desligarTodas(true); await Promise.all([...pend]);
        await nuvem.sair(); return;
      }
      case "ping": return;
    }
    if (!eu) throw Object.assign(new Error("Entre primeiro (login ou apelido)."), { legivel: true });
    switch (msg.tipo) {
      case "historico": return emit({ tipo: "historico", partidas: eu.convidado ? [] : await nuvem.historico(eu.uid) });
      case "criar_sala": return criarSala();
      case "entrar_sala": return entrarSala(msg);
      default: return comandoDeJogo(msg);
    }
  }
  async function enviar(msg) {
    try { await tratar(msg); } catch (e) { if (!e.legivel && typeof console !== "undefined") console.error(e); erroMsg(legivel(e)); }
  }

  return { iniciar, enviar, _estado: () => ({ eu, sala: [...salas.values()].pop() || null, salas }) };
});
