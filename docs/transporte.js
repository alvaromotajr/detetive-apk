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

  let eu = null, sala = null, contErro = 0, jaRegistradas = new Set(), uidsDaSala = new Set();
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
    if (sala) await desligarSala(true);
    eu = null; emit({ tipo: "deslogado" });
  }
  function iniciar() {
    return nuvem.aoMudarUsuario(u => { (u === null ? deslogou() : autenticar(u)).catch(() => {}); });
  }

  /* ----------------------------------------------------------------- salas */
  function entregar(codigo, uid, msg) {
    if (eu && uid === eu.uid) entregarLocal(msg); else acompanha(nuvem.escreverSaida(codigo, uid, msg));
  }
  function entregarLocal(msg) {
    if (msg.tipo === "sala" && sala) { sala.entrando = false; sala.cancelaEspera && sala.cancelaEspera(); }
    if (msg.tipo === "jogo" && sala && msg.visao.fase === "fim" && !jaRegistradas.has(sala.codigo + ":" + JSON.stringify(msg.visao.solucao)) && eu && !eu.convidado) {
      jaRegistradas.add(sala.codigo + ":" + JSON.stringify(msg.visao.solucao));
      const v = msg.visao, ev = v.eventos || [], meu = e => e.jogador === v.voce;
      nuvem.registrarPartida(eu.uid, sala.codigo + "-" + (v.solucao ? v.solucao.length : 0) + ev.length, {
        venceu: v.vencedor === v.voce, jogadores: v.jogadores.length,
        palpites: ev.filter(e => e.tipo === "palpite" && meu(e)).length, rodadas: ev.filter(e => e.tipo === "vez_de").length,
        acusou: ev.some(e => (e.tipo === "acusacao_certa" || e.tipo === "acusacao_errada") && meu(e)), solucao: v.solucao || null,
      });
    }
    if (msg.tipo === "saiu_da_sala") { desligarSala(false).then(() => emit(msg)); return; }
    emit(msg);
    if (msg.tipo === "erro" && sala && sala.entrando) desligarSala(false);
  }

  function novaSala(codigo, host) {
    sala = { codigo, host, juiz: null, entrando: !host, unsubs: [], timers: [], ultimaMudanca: relogio(), juizOffline: false, uids: new Set(), cancelaEspera: null };
    uidsDaSala = new Set();
    guardado.gravar("detetive_sala", JSON.stringify({ codigo, host }));
    return sala;
  }
  async function desligarSala(encerrarComoJuiz) {
    const s = sala; if (!s) return;
    sala = null; guardado.apagar("detetive_sala");
    s.cancelaEspera && s.cancelaEspera();
    s.unsubs.forEach(f => { try { f(); } catch (e) { /* ok */ } }); s.timers.forEach(f => f());
    if (s.host && s.juiz && !s.juiz.encerrada && encerrarComoJuiz) { sala = null; s.juiz.encerrar("O anfitrião saiu."); }
    emit({ tipo: "juiz_offline", offline: false });
  }

  function opcoesJuiz(codigo) {
    let ocupado = false, pendente = null;
    const salvar = async obj => {
      pendente = obj; if (ocupado) return; ocupado = true;
      while (pendente) { const x = pendente; pendente = null; await nuvem.salvarEstado(codigo, x); }
      ocupado = false;
    };
    return {
      relogio, enviar: (uid, m) => entregar(codigo, uid, m), salvar, agenda: (f, ms) => agenda.depois(f, ms),
      aoEncerrar: (motivo, uids) => { const todos = [...new Set([...uidsDaSala, ...(uids || [])])]; agenda.depois(() => nuvem.apagarSala(codigo, todos), 15000); },
    };
  }
  function ligarJuiz(codigo, juiz) {
    const s = sala;
    s.juiz = juiz;
    juiz.membros.forEach(m => { if (!m.bot) { s.uids.add(m.uid); uidsDaSala.add(m.uid); } });
    s.unsubs.push(nuvem.escutarComandos(codigo, async c => {
      if (c.msg && c.uid) { s.uids.add(c.uid); uidsDaSala.add(c.uid); juiz.receber(c.uid, c.nome, c.msg); }
      await nuvem.apagarComando(codigo, c.id);
    }));
    s.unsubs.push(nuvem.escutarPresenca(codigo, (uid, t, primeira) => {
      if (primeira && t != null && relogio() - t > 45000) return;
      juiz.presenca(uid);
    }));
    s.unsubs.push(nuvem.escutarSala(codigo, d => {      // outro jogador assumiu: volto a ser jogador comum
      if (d && d.hostUid && d.hostUid !== eu.uid && sala === s && s.host) perdeuJuiz(codigo);
    }));
    s.timers.push(agenda.cada(() => juiz.tick(), 5000));
    s.timers.push(agenda.cada(() => nuvem.baterJuiz(codigo), 20000));
  }
  async function perdeuJuiz(codigo) {
    await desligarSala(false);
    erroMsg("Outro jogador assumiu a partida. Você continua jogando.");
    const s = novaSala(codigo, false);
    ligarCliente(codigo); esperarResposta(s);
    await nuvem.enviarComando(codigo, eu.uid, eu.nome, { tipo: "entrar_sala" });
  }
  /* O anfitrião sumiu: quem estiver na sala pode continuar de onde parou. */
  async function assumirPartida() {
    if (!sala || sala.host) return;
    const s = sala, codigo = s.codigo;
    if (!s.juizOffline) throw Object.assign(new Error("O anfitrião ainda está por aqui."), { legivel: true });
    await nuvem.assumirSala(codigo, eu.uid);
    const estado = await nuvem.lerEstado(codigo).catch(() => null);
    if (!estado) throw Object.assign(new Error("Não achei a partida salva. Peça para o anfitrião voltar."), { legivel: true });
    await desligarSala(false);
    novaSala(codigo, true);
    const juiz = Juiz.restaurar(estado, opcoesJuiz(codigo));
    ligarJuiz(codigo, juiz);
    juiz.transferir(eu.uid, eu.nome);
  }
  function ligarCliente(codigo) {
    const s = sala, ultimo = {}; let primeira = true;
    s.unsubs.push(nuvem.escutarSaida(codigo, eu.uid, out => {
      s.ultimaSaida = (s.ultimaSaida || 0) + 1;
      const ordem = ["sala", "jogo", "caderno", "erro", "saiu_da_sala"];
      for (const tipo of ordem) {
        if (!out[tipo]) continue;
        const chave = JSON.stringify(out[tipo]);
        if (ultimo[tipo] === chave) continue;
        ultimo[tipo] = chave;
        if (tipo === "erro" && primeira) continue;      // erro velho
        if (sala !== s) return;
        entregarLocal(out[tipo]);
      }
      primeira = false;
    }));
    s.unsubs.push(nuvem.escutarSala(codigo, d => {
      s.ultimaMudanca = relogio();
      if (d === null && sala === s && !s.entrando) entregarLocal({ tipo: "saiu_da_sala", motivo: "A sala foi encerrada." });
    }));
    s.timers.push(agenda.cada(() => nuvem.presenca(codigo, eu.uid), 20000));
    s.timers.push(agenda.cada(() => {
      const seg = Math.round((relogio() - s.ultimaMudanca) / 1000), off = seg * 1000 > ONLINE_JUIZ;
      if (off !== s.juizOffline || off) { s.juizOffline = off; emit({ tipo: "juiz_offline", offline: off, segundos: off ? seg : 0 }); }
    }, 10000));
    nuvem.presenca(codigo, eu.uid);
  }
  function esperarResposta(s) {
    s.cancelaEspera = agenda.depois(() => {
      if (sala === s && s.entrando) { desligarSala(false); erroMsg("O anfitrião não respondeu. Ele precisa estar com o app aberto."); }
    }, 12000);
  }

  async function criarSala() {
    if (sala) throw Object.assign(new Error("Você já está em uma sala. Saia dela antes."), { legivel: true });
    let codigo = null;
    for (let i = 0; i < 6 && !codigo; i++) {
      const c = Array.from({ length: 5 }, () => ALFABETO[sorteio(ALFABETO.length)]).join("");
      if (!(await nuvem.lerSala(c))) codigo = c;
    }
    if (!codigo) throw new Error("sem código");
    await nuvem.criarSala(codigo, eu.uid);
    novaSala(codigo, true);
    const juiz = new Juiz({ ...opcoesJuiz(codigo), codigo, uidAnfitriao: eu.uid, nomeAnfitriao: eu.nome });
    ligarJuiz(codigo, juiz);
  }
  async function entrarSala(msg) {
    if (sala) throw Object.assign(new Error("Você já está em uma sala. Saia dela antes."), { legivel: true });
    const codigo = String(msg.codigo || "").trim().toUpperCase();
    if (!/^[A-Z]{3,8}$/.test(codigo)) throw Object.assign(new Error("Sala não encontrada. Confira o código."), { legivel: true });
    const d = await nuvem.lerSala(codigo);
    if (!d) throw Object.assign(new Error("Sala não encontrada. Confira o código."), { legivel: true });
    if (d.hostUid === eu.uid) { novaSala(codigo, true); await retomarJuiz(codigo); return; }
    const s = novaSala(codigo, false);
    ligarCliente(codigo); esperarResposta(s);
    await nuvem.enviarComando(codigo, eu.uid, eu.nome, { tipo: "entrar_sala" });
  }
  async function retomarJuiz(codigo) {
    const estado = await nuvem.lerEstado(codigo);
    if (!estado || estado.uidAnfitriao !== eu.uid) { await desligarSala(false); return; }
    const juiz = Juiz.restaurar(estado, opcoesJuiz(codigo));
    ligarJuiz(codigo, juiz); juiz.reenviarTudo();
  }
  async function retomar() {
    if (sala || !eu) return;
    let salvo = null; try { salvo = JSON.parse(guardado.ler("detetive_sala") || "null"); } catch (e) { /* ignora */ }
    if (!salvo || !salvo.codigo) return;
    const d = await nuvem.lerSala(salvo.codigo).catch(() => null);
    if (!d) { guardado.apagar("detetive_sala"); return; }
    if (d.hostUid === eu.uid) { novaSala(salvo.codigo, true); await retomarJuiz(salvo.codigo); return; }
    const s = novaSala(salvo.codigo, false);
    ligarCliente(salvo.codigo); esperarResposta(s);
    await nuvem.enviarComando(salvo.codigo, eu.uid, eu.nome, { tipo: "entrar_sala" });
  }

  /* --------------------------------------------------------------- entrada */
  async function comandoDeJogo(msg) {
    if (!sala) throw Object.assign(new Error("Você não está em uma sala."), { legivel: true });
    if (sala.host) { sala.juiz.receber(eu.uid, eu.nome, msg); return; }
    const s = sala;
    const antes = s.ultimaSaida || 0;
    await nuvem.enviarComando(s.codigo, eu.uid, eu.nome, msg);
    if (!["sair_sala", "chat", "assumir"].includes(msg.tipo)) agenda.depois(() => {
      if (sala === s && !s.entrando && (s.ultimaSaida || 0) === antes) erroMsg("O anfitrião ainda não respondeu. Se o app dele estiver fechado, a jogada fica esperando.");
    }, 10000);
    if (msg.tipo === "sair_sala") agenda.depois(() => { if (sala === s) entregarLocal({ tipo: "saiu_da_sala" }); }, 4000);
  }
  async function tratar(msg) {
    if (!msg || typeof msg.tipo !== "string") throw Object.assign(new Error("Mensagem inválida."), { legivel: true });
    switch (msg.tipo) {
      case "registrar": return autenticar(await nuvem.registrar(msg.usuario, msg.senha));
      case "entrar": return autenticar(await nuvem.entrar(msg.usuario, msg.senha));
      case "convidado": return autenticar(await nuvem.convidado(msg.apelido));
      case "retomar": return retomar();
      case "assumir": return assumirPartida();
      case "sair_conta": {
        if (sala) {
          const s = sala;
          if (!s.host) await nuvem.enviarComando(s.codigo, eu.uid, eu.nome, { tipo: "sair_sala" }).catch(() => {});
          await desligarSala(true); await Promise.all([...pend]);
        }
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

  return { iniciar, enviar, _estado: () => ({ eu, sala }) };
});
