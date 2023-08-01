import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Interval, TabStateType } from '../common';

export type IntervalInputContextType = {
  reloadData: TabStateType;
  unSavedIntervals: Interval;
  setUnSavedIntervals: React.Dispatch<React.SetStateAction<Interval>>;
};

export const IntervalInputContext = createContext<IntervalInputContextType>(
  {} as IntervalInputContextType
);

// provides context/state data to all interval inputs
export const useIntervalInputContext = () =>
  useContext(IntervalInputContext) as IntervalInputContextType;
