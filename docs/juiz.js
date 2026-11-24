/* O juiz: roda só no celular de quem criou a sala.
   Recebe os comandos dos jogadores, aplica as regras (motor.js) e devolve a cada um
   só o que ele pode ver. Não conhece Firebase: usa as funções que recebe no construtor. */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica(require("./motor.js"));
  else raiz.Juiz = fabrica(raiz.Motor);
})(typeof self !== "undefined" ? self : this, function (Motor) {
  "use strict";
  const { Jogo, Mapa, ErroJogo, Fase, MIN_JOGADORES, MAX_JOGADORES, PACOTES, BOA_ESPERANCA } = Motor;

  const ONLINE_ATE = 45000;      // sem sinal por mais que isso = "caiu"
  const REMOVER_APOS = 90000;    // sem sinal por tanto tempo = o grupo pode remover
  const MARCAS = ["vista", "suspeita", "pensar"];
  const FRASES = ["Boa jogada! 👏", "Hmm, interessante… 🤔", "Estou de olho em você 👀", "Quase lá! 🔍", "Que azar! 😅", "Já sei quem foi! 😏", "Não fui eu! 🙅", "Calma, estou pensando… 💭", "Vamos acelerar? ⏱", "Cuidado com o palpite! ⚠", "Parabéns! 🎉", "Boa sorte a todos! 🍀"];
  const NOMES_BOT = ["Bot Clara", "Bot Dante", "Bot Elisa", "Bot Fausto", "Bot Gema", "Bot Hugo", "Bot Iris"];
  const RE_APELIDO = /^[\p{L}\p{N}_][\p{L}\p{N}_ .'-]{0,14}[\p{L}\p{N}_]$/u;

  class Juiz {
    /* opcoes: { codigo, uidAnfitriao, nomeAnfitriao, pacote?, relogio?, enviar(uid,msg), salvar(obj), aoEncerrar(motivo), rng? } */
    constructor(o) {
      this.codigo = o.codigo; this.uidAnfitriao = o.uidAnfitriao; this.anfitriao = o.nomeAnfitriao;
      this.pacote = o.pacote || BOA_ESPERANCA;
      this.relogio = o.relogio || (() => Date.now());
      this._enviar = (uid, msg) => { if (!String(uid).startsWith("bot:")) o.enviar(uid, msg); };   // bots não têm caixa de saída
      this._agenda = o.agenda || ((f) => f()); this.atrasoBot = o.atrasoBot == null ? 1500 : o.atrasoBot; this._botPendente = false;
      this._push = o.push || (() => {}); this._chavePush = null;
      this._salvar = o.salvar || (() => {}); this._aoEncerrar = o.aoEncerrar || (() => {});
      this.rng = o.rng || null;
      this.membros = new Map();      // nome -> { nome, uid, visto, saiu }
      this.tempoVez = 0; this.marcaVez = null; this._chaveVez = null; this.jogo = null; this.cadernos = {}; this.chat = []; this.chatN = 0; this.ultimos = new Map(); this.contErro = 0; this.encerrada = false;
      this._adicionar(o.nomeAnfitriao, o.uidAnfitriao);
      if (!o.restaurando) { this._transmitirSala(); this._salvarEstado(); }
    }

    /* ------------------------------------------------------------ util */
    _adicionar(nome, uid) { this.membros.set(nome, { nome, uid, visto: this.relogio(), saiu: false }); }
    _doUid(uid) { for (const m of this.membros.values()) if (m.uid === uid && !m.saiu) return m; return null; }
    _online(m) { return m.bot || m.uid === this.uidAnfitriao || this.relogio() - m.visto < ONLINE_ATE; }
    _emitir(uid, msg) {
      const chave = JSON.stringify(msg);
      let mapa = this.ultimos.get(uid); if (!mapa) this.ultimos.set(uid, mapa = new Map());
      if (mapa.get(msg.tipo) === chave) return;
      mapa.set(msg.tipo, chave); this._enviar(uid, msg);
    }
    _erro(uid, texto) { this._enviar(uid, { tipo: "erro", mensagem: texto, n: ++this.contErro }); }

    /* Segundos que restam na vez (ou na carta a mostrar). null = sem relógio. */
    _restam() {
      if (!this.jogo || !this.tempoVez || this.jogo.fase === Fase.FIM) return null;
      const g = this.jogo, chave = g.turno + ":" + (g.fase === Fase.REFUTANDO ? "r" + g.refutador : "v");
      if (chave !== this._chaveVez) { this._chaveVez = chave; this.marcaVez = this.relogio(); }
      return Math.max(0, Math.ceil(this.tempoVez * 60 - (this.relogio() - this.marcaVez) / 1000));
    }
    _estadoSala() {
      return {
        tipo: "sala", codigo: this.codigo, anfitriao: this.anfitriao, iniciada: !!this.jogo,
        minimo: MIN_JOGADORES, maximo: MAX_JOGADORES, cenario: this.pacote.nome, vitima: this.pacote.vitima,
        cenarioId: this.pacote.id, cenarios: Object.values(PACOTES).map(p => ({ id: p.id, nome: p.nome })),
        tabuleiro: new Mapa(this.pacote).layout(),
        emojiSuspeitos: [...this.pacote.emojiSuspeitos], emojiLocais: { ...this.pacote.emojiLocais }, tema: { ...this.pacote.tema },
        cartas: { suspeitos: [...this.pacote.suspeitos], locais: [...this.pacote.locais], armas: [...this.pacote.armas] },
        grade: this.pacote.grade.map(l => [...l]), atalhos: this.pacote.atalhos.map(a => [...a]),
        jogadores: [...this.membros.values()].map(m => ({ nome: m.nome, conectado: this._online(m), saiu: m.saiu, bot: !!m.bot })),
        frases: FRASES, chat: this.chat.map(c => ({ ...c })),
        tempo_vez: this.tempoVez, restam: this._restam(), bots_vel: this.atrasoBot < 1200 ? "rapido" : "lento",
      };
    }
    _transmitirSala() {
      const e = this._estadoSala();
      for (const m of this.membros.values()) if (!m.saiu) this._emitir(m.uid, e);
    }
    _visao(nome) {
      const v = this.jogo.visaoPara(nome);
      for (const info of v.jogadores) { const m = this.membros.get(info.nome); info.conectado = this._online(m); info.saiu = m.saiu; info.bot = !!m.bot; }
      return v;
    }
    /* Quem deve ser avisado por push (app fechado): a vez, a carta a mostrar e o fim do caso. */
    _chaveAtual() { const g = this.jogo; return g ? JSON.stringify([g.fase === Fase.FIM ? null : g.jogadorDaVez, g.fase === Fase.REFUTANDO ? g.refutador : null, g.fase === Fase.FIM]) : null; }
    _avisarPush() {
      const g = this.jogo, chave = this._chaveAtual();
      if (!g || chave === this._chavePush) return;
      this._chavePush = chave;
      const alvo = n => { const m = this.membros.get(n); return m && !m.bot && !m.saiu && m.uid !== this.uidAnfitriao ? m.uid : null; };
      const sala = this.codigo ? ` · ${this.codigo}` : "";
      try {
        if (g.fase === Fase.FIM) {
          const todos = [...this.membros.values()].filter(m => !m.bot && !m.saiu && m.uid !== this.uidAnfitriao).map(m => m.uid);
          if (todos.length) this._push(todos, { tipo: "jogada", titulo: "Caso encerrado" + sala, texto: g.vencedor ? `${g.vencedor} venceu.` : "Ninguém resolveu." });
          return;
        }
        if (g.fase === Fase.REFUTANDO && alvo(g.refutador) && g.palpite) {
          const p = g.palpite;
          this._push([alvo(g.refutador)], { tipo: "vez", titulo: "🃏 Mostre uma carta" + sala, texto: `${p.jogador} palpitou: ${p.suspeito}, ${p.local}, ${p.arma}.` });
          return;
        }
        if (g.fase !== Fase.REFUTANDO && alvo(g.jogadorDaVez)) this._push([alvo(g.jogadorDaVez)], { tipo: "vez", titulo: "🎯 É a sua vez!" + sala, texto: "Role os dados e ande pelo mapa." });
      } catch (e) { /* push é um extra */ }
    }
    _transmitirJogo() {
      if (!this.jogo) return;
      this._avisarPush();
      for (const m of this.membros.values()) {
        if (m.saiu && !(m.nome in this.jogo.maos)) continue;
        if (m.nome in this.jogo.maos && !m.saiu) this._emitir(m.uid, { tipo: "jogo", visao: this._visao(m.nome) });
      }
    }
    _transmitirTudo() { this._transmitirSala(); this._transmitirJogo(); this._salvarEstado(); }
    _salvarEstado() { this._salvar(this.serializar()); }

    /* ------------------------------------------------------- entrada */
    /* Chamado pela nuvem a cada comando recebido. `nome` é o que o jogador informou ao entrar. */
    receber(uid, nome, msg) {
      if (this.encerrada) return;
      try {
        if (!msg || typeof msg !== "object" || typeof msg.tipo !== "string") throw new ErroJogo("Mensagem inválida.");
        const acoes = {
          rolar: (j, n) => j.rolarDados(n),
          mover: (j, n) => j.mover(n, texto(msg.destino)),
          parar: (j, n) => j.pararAqui(n),
          atalho: (j, n) => j.usarAtalho(n),
          palpitar: (j, n) => j.palpitar(n, texto(msg.suspeito), texto(msg.arma)),
          mostrar: (j, n) => j.mostrarCarta(n, texto(msg.carta)),
          acusar: (j, n) => j.acusar(n, texto(msg.suspeito), texto(msg.local), texto(msg.arma)),
          encerrar: (j, n) => j.encerrarTurno(n),
        };
        if (msg.tipo === "entrar_sala") return this._entrar(uid, nome);
        const m = this._doUid(uid);
        if (!m) throw new ErroJogo("Você não está nesta sala.");
        m.visto = this.relogio();
        if (msg.tipo in acoes) {
          if (!this.jogo) throw new ErroJogo("A partida ainda não começou.");
          acoes[msg.tipo](this.jogo, m.nome); this._transmitirJogo(); this._transmitirSala();
          this._salvarEstado(); this._pensarBots(); return;
        }
        if (msg.tipo === "sair_sala") return this._sair(uid);
        if (msg.tipo === "iniciar") return this._iniciar(uid);
        if (msg.tipo === "escolher_cenario") return this._escolherCenario(uid, msg);
        if (msg.tipo === "add_bot") return this._addBot(uid);
        if (msg.tipo === "remover_bot") return this._removerBot(uid, msg);
        if (msg.tipo === "remover_desconectado") return this._removerSumido(uid, msg);
        if (msg.tipo === "caderno") return this._caderno(uid, msg);
        if (msg.tipo === "chat") return this._chat(uid, msg);
        if (msg.tipo === "cutucar") return this._cutucar(uid);
        if (msg.tipo === "tempo_vez") return this._configurar(uid, msg, "tempo");
        if (msg.tipo === "bots_velocidade") return this._configurar(uid, msg, "bots");
        if (msg.tipo === "revanche") return this._revanche(uid);
        throw new ErroJogo("Comando desconhecido.");
      } catch (e) {
        if (e instanceof ErroJogo) this._erro(uid, e.message); else { this._erro(uid, "Algo deu errado. Tente de novo."); if (typeof console !== "undefined") console.error(e); }
      }
    }

    /* sinal de vida de um jogador */
    presenca(uid) { const m = this._doUid(uid); if (m) m.visto = this.relogio(); }

    /* Chamar a cada ~15 s: mostra quem caiu e tira do lobby quem sumiu. */
    tick() {
      if (this.encerrada) return;
      let mudou = false;
      if (!this.jogo) {
        for (const m of [...this.membros.values()]) {
          if (!m.bot && m.uid !== this.uidAnfitriao && this.relogio() - m.visto >= REMOVER_APOS) { this.membros.delete(m.nome); mudou = true; this.ultimos.delete(m.uid); this._enviar(m.uid, { tipo: "saiu_da_sala", motivo: "Você ficou sem conexão e saiu da sala." }); }
        }
      }
      const assinatura = [...this.membros.values()].map(m => m.nome + this._online(m)).join("|");
      if (assinatura !== this._assinatura) { this._assinatura = assinatura; mudou = true; }
      if (this.jogo && this.tempoVez && this.jogo.fase !== Fase.FIM && this._restam() <= 0) {
        const nome = this.jogo.fase === Fase.REFUTANDO ? this.jogo.refutador : this.jogo.jogadorDaVez, m = this.membros.get(nome);
        if (!(m && m.bot)) { this.jogo.tempoEsgotado(); mudou = true; }
      }
      if (mudou) { this._transmitirTudo(); this._pensarBots(); }
    }

    _entrar(uid, nome) {
      if (this.jogo) throw new ErroJogo("Essa partida já começou.");
      if (typeof nome !== "string" || !RE_APELIDO.test(nome.trim())) throw new ErroJogo("Nome inválido.");
      nome = nome.trim();
      const ja = this._doUid(uid);
      if (ja) { ja.visto = this.relogio(); return this._transmitirTudo(); }   // já estava: só reenvia
      if (this.membros.size >= MAX_JOGADORES) throw new ErroJogo("A sala está cheia.");
      if (this.membros.has(nome)) throw new ErroJogo("Já tem alguém com esse nome na sala.");
      this._adicionar(nome, uid); this._transmitirTudo();
    }
    _sair(uid) {
      const m = this._doUid(uid); if (!m) return;
      if (uid === this.uidAnfitriao) return this.encerrar("O anfitrião encerrou a sala.");
      if (!this.jogo) this.membros.delete(m.nome);
      else { m.saiu = true; this.jogo.remover(m.nome); }
      this._enviar(uid, { tipo: "saiu_da_sala" }); this.ultimos.delete(uid);
      this._transmitirTudo();
    }
    _iniciar(uid) {
      if (this.jogo) throw new ErroJogo("A partida já começou.");
      const m = this._doUid(uid);
      if (!m || m.nome !== this.anfitriao) throw new ErroJogo("Só quem criou a sala pode iniciar.");
      const nomes = [...this.membros.values()].filter(x => !x.saiu).map(x => x.nome);
      if (nomes.length < MIN_JOGADORES) throw new ErroJogo(`Precisa de pelo menos ${MIN_JOGADORES} jogadores.`);
      this.jogo = new Jogo(nomes, this.pacote, this.rng);
      this.cadernos = Object.fromEntries(nomes.map(n => [n, {}]));
      this._transmitirTudo(); this._pensarBots();
    }
    _escolherCenario(uid, msg) {
      if (this.jogo) throw new ErroJogo("A partida já começou.");
      const m = this._doUid(uid);
      if (!m || m.nome !== this.anfitriao) throw new ErroJogo("Só quem criou a sala escolhe o cenário.");
      const p = PACOTES[texto(msg.id)];
      if (!p) throw new ErroJogo("Cenário desconhecido.");
      this.pacote = p; this._transmitirTudo();
    }
    _addBot(uid) {
      if (this.jogo) throw new ErroJogo("A partida já começou.");
      const m = this._doUid(uid);
      if (!m || m.nome !== this.anfitriao) throw new ErroJogo("Só quem criou a sala pode adicionar bots.");
      if (this.membros.size >= MAX_JOGADORES) throw new ErroJogo("A sala está cheia.");
      const nome = NOMES_BOT.find(n => !this.membros.has(n));
      if (!nome) throw new ErroJogo("Não dá para adicionar mais bots.");
      this.membros.set(nome, { nome, uid: "bot:" + nome, visto: this.relogio(), saiu: false, bot: true });
      this._transmitirTudo();
    }
    _removerBot(uid, msg) {
      if (this.jogo) throw new ErroJogo("A partida já começou.");
      const m = this._doUid(uid);
      if (!m || m.nome !== this.anfitriao) throw new ErroJogo("Só quem criou a sala pode remover bots.");
      const b = this.membros.get(texto(msg.nome));
      if (!b || !b.bot) throw new ErroJogo("Esse jogador não é um bot.");
      this.membros.delete(b.nome); this._transmitirTudo();
    }

    /* ------------------------------------------------------------ bots */
    /* Quem precisa agir agora, se for um bot. */
    _atorBot() {
      const j = this.jogo; if (!j || j.fase === Fase.FIM) return null;
      const nome = j.fase === Fase.REFUTANDO ? j.refutador : j.jogadorDaVez;
      const m = this.membros.get(nome);
      return m && m.bot && !m.saiu ? m : null;
    }
    /* Agenda o próximo passo do bot (com uma pausa, para dar tempo de ler o que aconteceu). */
    _pensarBots() {
      if (this._botPendente || this.encerrada) return;
      if (this._emLaco) { this._deNovo = true; return; }     // já estamos num laço: ele continua sozinho
      this._emLaco = true;
      try {
        for (let guarda = 0; guarda < 5000; guarda++) {
          this._deNovo = false;
          if (!this._atorBot()) break;
          this._botPendente = true;
          this._agenda(() => this._executarBot(), this.atrasoBot);
          if (!this._deNovo || this.encerrada) break;
        }
      } finally { this._emLaco = false; }
    }
    _executarBot() {
      this._botPendente = false;
      if (this.encerrada) return;
      const m = this._atorBot(); if (!m) return;
      this._passoBot(m.nome);
      this._transmitirJogo(); this._transmitirSala(); this._salvarEstado();
      this._pensarBots();
    }
    /* Um bot joga limpo: só usa o que um jogador de verdade saberia (visaoPara). */
    _passoBot(nome) {
      const j = this.jogo, p = this.pacote, v = j.visaoPara(nome);
      const conhecidas = new Set([...v.sua_mao, ...v.cartas_publicas]);
      for (const e of v.eventos) if (e.tipo === "carta_revelada" && e.carta) conhecidas.add(e.carta);
      // Se ninguém refutou um palpite meu, as cartas dele que eu não tenho são o culpado, o local e a arma.
      const sabida = {}; let meu = null;
      for (const e of v.eventos) {
        if (e.tipo === "palpite") meu = e.jogador === nome ? e : null;
        else if (e.tipo === "vez_de") meu = null;
        else if (e.tipo === "ninguem_refutou" && meu) {
          if (!conhecidas.has(meu.suspeito)) sabida.s = meu.suspeito;
          if (!conhecidas.has(meu.local)) sabida.l = meu.local;
          if (!conhecidas.has(meu.arma)) sabida.a = meu.arma;
        }
      }
      const livres = (lista, k) => sabida[k] ? [sabida[k]] : lista.filter(c => !conhecidas.has(c));
      const cs = livres(p.suspeitos, "s"), cl = livres(p.locais, "l"), ca = livres(p.armas, "a");
      const combos = cs.length * cl.length * ca.length;
      const certo = combos === 1 || (combos === 2 && j.rng.int(0, 1) === 1);   // com 2 hipóteses, às vezes arrisca
      const sorteia = lista => j.rng.choice(lista);
      try {
        switch (j.fase) {
          case Fase.REFUTANDO: j.mostrarCarta(nome, sorteia(v.cartas_que_pode_mostrar)); break;
          case Fase.ROLAR: {
            if (certo && j.mapa.ehLocal(j.posicoes[nome])) { j.acusar(nome, cs[0], cl[0], ca[0]); break; }
            const aqui = j.posicoes[nome], dest = v.tem_atalho ? j.mapa.atalhos.get(aqui) : null;
            if (dest && cl.includes(dest) && !cl.includes(aqui)) j.usarAtalho(nome); else j.rolarDados(nome);
            break;
          }
          case Fase.MOVER: {
            const aqui = j.posicoes[nome];
            const ops = v.opcoes_movimento;
            if (!ops.length) { j.encerrarTurno(nome); break; }
            const locaisAlcancaveis = ops.filter(o => j.mapa.ehLocal(o));
            const uteis = locaisAlcancaveis.filter(o => cl.includes(o));
            const novos = uteis.filter(o => o !== aqui);
            if (novos.length) { j.mover(nome, sorteia(novos)); break; }
            if (uteis.length && cl.length === 1) { j.mover(nome, sorteia(uteis)); break; }   // já está no único local possível
            // Só resta o local onde palpitou por último: palpita em outro lugar para poder voltar depois.
            const proib = v.ultimo_palpite_local, soProibido = !!proib && cl.every(l => l === proib);
            if (soProibido && locaisAlcancaveis.length) { j.mover(nome, sorteia(locaisAlcancaveis)); break; }
            // Nenhum local candidato ao alcance: anda na direção do mais próximo.
            const alvos = soProibido ? [...j.mapa.locais].filter(l => l !== proib && l !== aqui) : cl.filter(l => l !== aqui);
            const lista = alvos.length ? alvos : cl;
            let melhor = Infinity, alvo = lista[0];
            for (const l of lista) { const d = j.mapa.distancia(aqui, l); if (d < melhor) { melhor = d; alvo = l; } }
            let escolha = null, dmin = Infinity;
            for (const o of ops) { const d = o === alvo ? -1 : j.mapa.distancia(o, alvo); if (d < dmin) { dmin = d; escolha = o; } }
            j.mover(nome, escolha);
            if (j.fase === Fase.MOVER && !j.mapa.ehLocal(j.posicoes[nome])) j.pararAqui(nome);
            break;
          }
          case Fase.PALPITE: j.palpitar(nome, sorteia(cs.length ? cs : p.suspeitos), sorteia(ca.length ? ca : p.armas)); break;
          case Fase.POS_PALPITE: if (certo && j.mapa.ehLocal(j.posicoes[nome])) j.acusar(nome, cs[0], cl[0], ca[0]); else j.encerrarTurno(nome); break;
        }
      } catch (e) {
        if (!(e instanceof ErroJogo)) throw e;
        try { if (j.fase === Fase.REFUTANDO) j.mostrarCarta(nome, v.cartas_que_pode_mostrar[0]); else j.encerrarTurno(nome); } catch (_) { j.remover(nome); }
      }
    }
    _removerSumido(uid, msg) {
      if (!this.jogo) throw new ErroJogo("A partida ainda não começou.");
      const alvo = this.membros.get(texto(msg.nome));
      if (!alvo || alvo.saiu) throw new ErroJogo("Jogador não encontrado.");
      if (alvo.uid === uid) throw new ErroJogo("Para sair você mesmo, use sair da sala.");
      if (alvo.uid === this.uidAnfitriao) throw new ErroJogo("O anfitrião não pode ser removido.");
      if (this._online(alvo)) throw new ErroJogo("Esse jogador está conectado.");
      if (this.relogio() - alvo.visto < REMOVER_APOS) throw new ErroJogo("Espere um pouco: ele pode voltar.");
      alvo.saiu = true; this.jogo.remover(alvo.nome); this._transmitirTudo();
    }
    _anfitriaoOuErro(uid, quando) {
      const m = this._doUid(uid);
      if (!m || m.nome !== this.anfitriao) throw new ErroJogo("Só quem criou a sala pode mudar isso.");
      return m;
    }
    _configurar(uid, msg, o) {
      this._anfitriaoOuErro(uid);
      if (o === "tempo") {
        if (this.jogo) throw new ErroJogo("A partida já começou.");
        const min = msg.minutos;
        if (!Number.isInteger(min) || min < 0 || min > 30) throw new ErroJogo("Tempo inválido (0 a 30 minutos).");
        this.tempoVez = min;
      } else {
        if (msg.v !== "rapido" && msg.v !== "lento") throw new ErroJogo("Velocidade inválida.");
        this.atrasoBot = msg.v === "rapido" ? 600 : 2500; this._botsVelDefinida = true;
      }
      this._transmitirSala(); this._salvarEstado();
    }
    /* Jogar de novo na mesma sala. */
    _revanche(uid) {
      this._anfitriaoOuErro(uid);
      if (!this.jogo || this.jogo.fase !== Fase.FIM) throw new ErroJogo("A partida ainda não terminou.");
      for (const m of [...this.membros.values()]) if (m.saiu) this.membros.delete(m.nome);
      this.jogo = null; this.cadernos = {}; this.marcaVez = null; this._chaveVez = null; this.ultimos.clear();
      this._transmitirTudo();
    }
    /* Lembra quem está na vez de jogar (no máximo uma vez a cada 30 s por pessoa). */
    _cutucar(uid) {
      const m = this._doUid(uid);
      if (!this.jogo || this.jogo.fase === "fim") throw new ErroJogo("A partida não está em andamento.");
      const alvo = this.membros.get(this.jogo.jogadorDaVez);
      if (!alvo || alvo.nome === m.nome) throw new ErroJogo("A vez é sua!");
      if (alvo.bot) throw new ErroJogo("A vez é de um bot. Ele joga sozinho.");
      this.cutucou = this.cutucou || new Map();
      const falta = 30000 - (this.relogio() - (this.cutucou.get(uid) || -1e12));
      if (falta > 0) throw new ErroJogo(`Espere ${Math.ceil(falta / 1000)}s para cutucar de novo.`);
      this.cutucou.set(uid, this.relogio()); this.cutucaN = (this.cutucaN || 0) + 1;
      this._enviar(alvo.uid, { tipo: "cutucada", de: m.nome, n: this.cutucaN });
      this._push([alvo.uid], { tipo: "vez", titulo: `🔔 ${m.nome} te cutucou`, texto: "É a sua vez de jogar!" });
    }
    _chat(uid, msg) {
      const m = this._doUid(uid), i = msg.i;
      if (!Number.isInteger(i) || i < 0 || i >= FRASES.length) throw new ErroJogo("Frase inválida.");
      this.chat.push({ n: ++this.chatN, de: m.nome, i }); if (this.chat.length > 40) this.chat.shift();
      this._transmitirSala(); this._salvarEstado();
    }
    _caderno(uid, msg) {
      if (!this.jogo) throw new ErroJogo("A partida ainda não começou.");
      const m = this._doUid(uid);
      if (!msg.marcas || typeof msg.marcas !== "object" || Array.isArray(msg.marcas)) throw new ErroJogo("Campo 'marcas' inválido.");
      const validas = new Set(Motor.todasAsCartas(this.pacote)), novo = {};
      for (const [carta, marca] of Object.entries(msg.marcas)) {
        if (!validas.has(carta) || !MARCAS.includes(marca)) throw new ErroJogo("Anotação inválida.");
        novo[carta] = marca;
      }
      this.cadernos[m.nome] = novo; this._enviar(uid, { tipo: "caderno", marcas: novo }); this._salvarEstado();
    }

    /* Fecha a sala para todos. */
    encerrar(motivo) {
      if (this.encerrada) return;
      this.encerrada = true;
      for (const m of this.membros.values()) if (!m.saiu || this.jogo) this._enviar(m.uid, { tipo: "saiu_da_sala", motivo });
      this._aoEncerrar(motivo, [...this.membros.values()].filter(m => !m.bot).map(m => m.uid));
    }

    /* Depois que o app do anfitrião reabre: manda tudo de novo a todos. */
    /* Outro jogador assume o lugar do anfitrião (o anfitrião original continua como jogador). */
    transferir(uid, nome) {
      const novo = this._doUid(uid) || this.membros.get(nome);
      if (!novo || novo.bot) throw new ErroJogo("Jogador não encontrado.");
      const antigo = this.membros.get(this.anfitriao); if (antigo) antigo.visto = this.relogio();
      this.uidAnfitriao = novo.uid; this.anfitriao = novo.nome; novo.visto = this.relogio();
      this._salvarEstado(); this.reenviarTudo();
    }
    reenviarTudo() {
      this.ultimos.clear();
      for (const m of this.membros.values()) if (this.jogo && m.nome in this.jogo.maos && !m.saiu) this._enviar(m.uid, { tipo: "caderno", marcas: this.cadernos[m.nome] || {} });
      this._transmitirTudo(); this._pensarBots();
    }

    /* --------------------------------------------------- persistência */
    serializar() {
      return {
        codigo: this.codigo, uidAnfitriao: this.uidAnfitriao, anfitriao: this.anfitriao, pacote: this.pacote.id,
        membros: [...this.membros.values()].map(m => ({ nome: m.nome, uid: m.uid, saiu: m.saiu, bot: !!m.bot })),
        jogo: this.jogo ? this.jogo.serializar() : null, cadernos: this.cadernos, chat: this.chat, chatN: this.chatN, tempoVez: this.tempoVez, atrasoBot: this._botsVelDefinida ? this.atrasoBot : null,
      };
    }
    static restaurar(o, opcoes) {
      const j = new Juiz({ ...opcoes, codigo: o.codigo, uidAnfitriao: o.uidAnfitriao, nomeAnfitriao: o.anfitriao, pacote: PACOTES[o.pacote], salvar: () => {}, restaurando: true });
      j.membros = new Map(o.membros.map(m => [m.nome, { ...m, visto: j.relogio() }]));
      j.jogo = o.jogo ? Jogo.restaurar(o.jogo, opcoes.rng || null) : null; j.cadernos = o.cadernos || {}; j.chat = o.chat || []; j.chatN = o.chatN || 0; j.tempoVez = o.tempoVez || 0; if (o.atrasoBot) { j.atrasoBot = o.atrasoBot; j._botsVelDefinida = true; }
      j._salvar = opcoes.salvar || (() => {}); j.ultimos.clear();
      j._chavePush = j._chaveAtual();         // ao retomar, não repete o aviso da vez que já foi enviado
      return j;
    }
  }

  function texto(v) { if (typeof v !== "string" || !v.trim() || v.length > 80) throw new ErroJogo("Campo inválido."); return v.trim(); }

  return { Juiz, ONLINE_ATE, REMOVER_APOS };
});
