/**
 *
 * The TicTacToe class exported by this file is used to interact with the
 * on-chain tic-tac-toe game program.
 *
 * @flow
 */

import EventEmitter from 'event-emitter';
import {Account, PublicKey, Transaction, SystemProgram} from '@solana/web3.js';
import type {AccountInfo, Connection} from '@solana/web3.js';

import * as ProgramCommand from './program-command';
import {deserializeGameState} from './program-state';
import type {GameState} from './program-state';
import {sendAndConfirmTransaction} from '../util/send-and-confirm-transaction';

export class TicTacToe {
  abandoned: boolean;
  disconnected: boolean;
  connection: Connection;
  programId: PublicKey;
  dashboard: PublicKey;
  gamePublicKey: PublicKey;
  isX: boolean;
  playerAccount: Account;
  state: GameState;
  inProgress: boolean;
  myTurn: boolean;
  draw: boolean;
  winner: boolean;
  _keepAliveErrorCount: number;

  _ee: EventEmitter;
  _changeSubscriptionId: number | null;

  /**
   * @private
   */
  constructor(
    connection: Connection,
    programId: PublicKey,
    dashboard: PublicKey,
    gamePublicKey: PublicKey,
    isX: boolean,
    playerAccount: Account,
  ) {
    const state = {
      board: [],
      gameState: 'Waiting',
      keepAlive: [0, 0],
      playerO: null,
      playerX: null,
    };

    Object.assign(this, {
      _changeSubscriptionId: null,
      _ee: new EventEmitter(),
      abandoned: false,
      disconnected: false,
      connection,
      draw: false,
      gamePublicKey,
      inProgress: false,
      isX,
      myTurn: false,
      playerAccount,
      programId,
      dashboard,
      state,
      winner: false,
      _keepAliveErrorCount: 0,
    });
  }

  /**
   * @private
   */
  scheduleNextKeepAlive() {
    if (this._changeSubscriptionId === null) {
      this._changeSubscriptionId = this.connection.onAccountChange(
        this.gamePublicKey,
        this._onAccountChange.bind(this),
      );
    }
    setTimeout(async () => {
      if (this.abandoned || this.disconnected) {
        const {_changeSubscriptionId} = this;
        if (_changeSubscriptionId !== null) {
          this._changeSubscriptionId = null;
          this.connection.removeAccountChangeListener(_changeSubscriptionId);
        }

        //console.log(`\nKeepalive exit, Game abandoned: ${this.gamePublicKey}\n`);
        return;
      }
      if (['XWon', 'OWon', 'Draw'].includes(this.state.gameState)) {
        //console.log(`\nKeepalive exit, Game over: ${this.gamePublicKey}\n`);
        return;
      }
      try {
        await this.keepAlive();
        this._keepAliveErrorCount = 0;
      } catch (err) {
        ++this._keepAliveErrorCount;
        console.error(
          `keepAlive() failed #${this._keepAliveErrorCount}: ${err}`,
        );
        if (this._keepAliveErrorCount > 3) {
          this.disconnected = true;
          this.inProgress = false;
          this._ee.emit('change');
        }
      }
      this.scheduleNextKeepAlive();
    }, 2000);
  }

  /**
   * Creates a new game, costing playerX 1 lamport
   */
  static async create(
    connection: Connection,
    programId: PublicKey,
    dashboard: PublicKey,
    playerXAccount: Account,
  ): Promise<TicTacToe> {
    const invalidAccount = new Account();
    const gameAccount = new Account();

    const transaction = SystemProgram.createAccount(
      // The initGame instruction funds `gameAccount`, so the account here can
      // be one with zero lamports (an invalid account)
      invalidAccount.publicKey,
      gameAccount.publicKey,
      0,
      255, // data space
      programId,
    );
    transaction.add({
      keys: [gameAccount.publicKey, dashboard, playerXAccount.publicKey],
      programId,
      data: ProgramCommand.initGame(),
    });

    await sendAndConfirmTransaction(
      'initGame',
      connection,
      transaction,
      playerXAccount,
      invalidAccount,
      gameAccount,
    );

    const ttt = new TicTacToe(
      connection,
      programId,
      dashboard,
      gameAccount.publicKey,
      true,
      playerXAccount,
    );
    ttt.scheduleNextKeepAlive();
    return ttt;
  }

  /**
   * Join an existing game as player O
   */
  static async join(
    connection: Connection,
    programId: PublicKey,
    dashboard: PublicKey,
    playerOAccount: Account,
    gamePublicKey: PublicKey,
  ): Promise<TicTacToe | null> {
    const ttt = new TicTacToe(
      connection,
      programId,
      dashboard,
      gamePublicKey,
      false,
      playerOAccount,
    );
    {
      const transaction = new Transaction().add({
        keys: [playerOAccount.publicKey, dashboard, gamePublicKey],
        programId,
        data: ProgramCommand.joinGame(),
      });
      await sendAndConfirmTransaction(
        'joinGame',
        connection,
        transaction,
        playerOAccount,
      );
    }

    ttt._onAccountChange(await connection.getAccountInfo(gamePublicKey));
    if (!ttt.inProgress) {
      return null;
    }
    if (ttt.state.playerO === null) {
      return null;
    }
    if (!playerOAccount.publicKey.equals(ttt.state.playerO)) {
      return null;
    }
    ttt.scheduleNextKeepAlive();
    return ttt;
  }

  /**
   * Send a keep-alive message to inform the other player that we're still alive
   */
  async keepAlive(): Promise<void> {
    const transaction = new Transaction().add({
      keys: [this.playerAccount.publicKey, this.dashboard, this.gamePublicKey],
      programId: this.programId,
      data: ProgramCommand.keepAlive(),
    });
    await sendAndConfirmTransaction(
      'keepAlive',
      this.connection,
      transaction,
      this.playerAccount,
    );
  }

  /**
   * Leave the game
   */
  abandon() {
    this.abandoned = true;
  }

  /**
   * Attempt to make a move.
   */
  async move(x: number, y: number): Promise<void> {
    const transaction = new Transaction().add({
      keys: [this.playerAccount.publicKey, this.dashboard, this.gamePublicKey],
      programId: this.programId,
      data: ProgramCommand.move(x, y),
    });
    await sendAndConfirmTransaction(
      `move(${x + 1},${y + 1})`,
      this.connection,
      transaction,
      this.playerAccount,
    );
  }

  /**
   * Fetch the latest state of the specified game
   */
  static async getGameState(
    connection: Connection,
    gamePublicKey: PublicKey,
  ): Promise<GameState> {
    const accountInfo = await connection.getAccountInfo(gamePublicKey);
    return deserializeGameState(accountInfo);
  }

  isPeerAlive(): boolean {
    const keepAliveDiff = Math.abs(
      this.state.keepAlive[0] - this.state.keepAlive[1],
    );
    return keepAliveDiff < 100; // ~10 seconds
  }

  /**
   * Update the `state` field with the latest state
   *
   * @private
   */
  _onAccountChange(accountInfo: AccountInfo) {
    this.state = deserializeGameState(accountInfo);
    this.inProgress = false;
    this.myTurn = false;
    this.draw = false;
    this.winner = false;

    switch (this.state.gameState) {
      case 'Waiting':
        break;
      case 'XMove':
        this.inProgress = true;
        this.myTurn = this.isX;
        break;
      case 'OMove':
        this.inProgress = true;
        this.myTurn = !this.isX;
        break;
      case 'Draw':
        this.draw = true;
        break;
      case 'XWon':
        this.winner = this.isX;
        break;
      case 'OWon':
        this.winner = !this.isX;
        break;
      default:
        throw new Error(`Unhandled game state: ${this.state.gameState}`);
    }

    if (this.inProgress && !this.isPeerAlive()) {
      this.inProgress = false;
      this.abandoned = true;
    }
    this._ee.emit('change');
  }

  /**
   * Register a callback for notification when the game state changes
   */
  onChange(fn: Function) {
    this._ee.on('change', fn);
  }

  /**
   * Remove a previously registered onChange callback
   */
  removeChangeListener(fn: Function) {
    this._ee.off('change', fn);
  }
}
