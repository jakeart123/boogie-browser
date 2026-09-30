// Eagle's built-in folder icons, by the name it writes in a folder's (or smart folder's) `icon`
// key, drawn with the nearest Lucide icon. Only Eagle's names are ever written back, so a folder
// iconed here looks right in the partner's Eagle too. Names not in this list keep the plain folder.
import type { Component } from 'svelte';
import Aperture from '@lucide/svelte/icons/aperture';
import Award from '@lucide/svelte/icons/award';
import Baby from '@lucide/svelte/icons/baby';
import Book from '@lucide/svelte/icons/book';
import BookOpen from '@lucide/svelte/icons/book-open';
import Box from '@lucide/svelte/icons/box';
import Brain from '@lucide/svelte/icons/brain';
import Briefcase from '@lucide/svelte/icons/briefcase';
import Calendar from '@lucide/svelte/icons/calendar';
import Camera from '@lucide/svelte/icons/camera';
import Cat from '@lucide/svelte/icons/cat';
import ChartBar from '@lucide/svelte/icons/chart-bar';
import ChartLine from '@lucide/svelte/icons/chart-line';
import ChartPie from '@lucide/svelte/icons/chart-pie';
import Clock from '@lucide/svelte/icons/clock';
import Coffee from '@lucide/svelte/icons/coffee';
import Cog from '@lucide/svelte/icons/cog';
import Contrast from '@lucide/svelte/icons/contrast';
import Crown from '@lucide/svelte/icons/crown';
import Dog from '@lucide/svelte/icons/dog';
import Download from '@lucide/svelte/icons/download';
import Eye from '@lucide/svelte/icons/eye';
import Film from '@lucide/svelte/icons/film';
import Flame from '@lucide/svelte/icons/flame';
import Gamepad from '@lucide/svelte/icons/gamepad-2';
import Gift from '@lucide/svelte/icons/gift';
import Globe from '@lucide/svelte/icons/globe';
import GraduationCap from '@lucide/svelte/icons/graduation-cap';
import Grid from '@lucide/svelte/icons/grid-3x3';
import Hand from '@lucide/svelte/icons/hand';
import Heart from '@lucide/svelte/icons/heart';
import House from '@lucide/svelte/icons/house';
import Image from '@lucide/svelte/icons/image';
import Images from '@lucide/svelte/icons/images';
import Layers from '@lucide/svelte/icons/layers';
import Library from '@lucide/svelte/icons/library';
import Lightbulb from '@lucide/svelte/icons/lightbulb';
import Mail from '@lucide/svelte/icons/mail';
import Monitor from '@lucide/svelte/icons/monitor';
import Music from '@lucide/svelte/icons/music';
import Palette from '@lucide/svelte/icons/palette';
import Paperclip from '@lucide/svelte/icons/paperclip';
import Presentation from '@lucide/svelte/icons/presentation';
import Scissors from '@lucide/svelte/icons/scissors';
import Search from '@lucide/svelte/icons/search';
import Shield from '@lucide/svelte/icons/shield';
import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Star from '@lucide/svelte/icons/star';
import ThumbsUp from '@lucide/svelte/icons/thumbs-up';
import Trophy from '@lucide/svelte/icons/trophy';
import Upload from '@lucide/svelte/icons/upload';
import User from '@lucide/svelte/icons/user';
import Users from '@lucide/svelte/icons/users';
import Video from '@lucide/svelte/icons/video';
import Wrench from '@lucide/svelte/icons/wrench';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Icon = Component<any>;

/** Eagle name -> icon, in the order Eagle's own picker shows them. */
export const FOLDER_ICONS: [string, Icon][] = [
  ['library', Library],
  ['box', Box],
  ['grid', Grid],
  ['layer', Layers],
  ['briefcase', Briefcase],
  ['photo', Image],
  ['photos', Images],
  ['video', Video],
  ['film', Film],
  ['music', Music],
  ['book', Book],
  ['book2', BookOpen],
  ['keynote', Presentation],
  ['camera', Camera],
  ['aperture', Aperture],
  ['attachment', Paperclip],
  ['scissors', Scissors],
  ['palette', Palette],
  ['wrench', Wrench],
  ['graph', ChartLine],
  ['cog', Cog],
  ['bachelor-cap', GraduationCap],
  ['email', Mail],
  ['coffee', Coffee],
  ['cart', ShoppingCart],
  ['lightbulb', Lightbulb],
  ['inspiration', Sparkles],
  ['thumb-up', ThumbsUp],
  ['like', Heart],
  ['star', Star],
  ['hot', Flame],
  ['upload', Upload],
  ['download', Download],
  ['shield', Shield],
  ['search', Search],
  ['clock', Clock],
  ['calendar-month', Calendar],
  ['website', Globe],
  ['desktop', Monitor],
  ['pie', ChartPie],
  ['bar-chart', ChartBar],
  ['contrast', Contrast],
  ['house', House],
  ['game', Gamepad],
  ['award', Award],
  ['crown', Crown],
  ['gift', Gift],
  ['eye', Eye],
  ['dog', Dog],
  ['cat', Cat],
  ['man', User],
  ['group', Users],
  ['baby', Baby],
  ['hand', Hand],
  ['brain', Brain],
  ['rophy', Trophy], // Eagle's own spelling
];

const BY_NAME = new Map(FOLDER_ICONS);

/** The icon for an Eagle icon name, or null for none / a name we don't draw. */
export function folderIcon(name: string | null | undefined): Icon | null {
  return (name && BY_NAME.get(name)) || null;
}
