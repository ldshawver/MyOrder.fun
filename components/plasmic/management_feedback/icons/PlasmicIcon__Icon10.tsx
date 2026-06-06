/* eslint-disable */
/* tslint:disable */
// @ts-nocheck
/* prettier-ignore-start */
import React from "react";
import { classNames } from "@plasmicapp/react-web";

export type Icon10IconProps = React.ComponentProps<"svg"> & {
  title?: string;
};

export function Icon10Icon(props: Icon10IconProps) {
  const { className, style, title, ...restProps } = props;
  return (
    <svg
      xmlns={"http://www.w3.org/2000/svg"}
      fill={"none"}
      viewBox={"0 0 24 24"}
      height={"1em"}
      width={"1em"}
      className={classNames("plasmic-default__svg", className)}
      style={style}
      {...restProps}
    >
      {title && <title>{title}</title>}

      <circle
        cx={"7"}
        cy={"14"}
        r={"1.25"}
        stroke={"currentColor"}
        strokeWidth={"1.5"}
        strokeLinecap={"round"}
        strokeLinejoin={"round"}
      ></circle>

      <circle
        cx={"12"}
        cy={"14"}
        r={"1.25"}
        stroke={"currentColor"}
        strokeWidth={"1.5"}
        strokeLinecap={"round"}
        strokeLinejoin={"round"}
      ></circle>

      <circle
        cx={"9"}
        cy={"10"}
        r={"1.25"}
        stroke={"currentColor"}
        strokeWidth={"1.5"}
        strokeLinecap={"round"}
        strokeLinejoin={"round"}
      ></circle>

      <circle
        cx={"15"}
        cy={"10"}
        r={"1.25"}
        stroke={"currentColor"}
        strokeWidth={"1.5"}
        strokeLinecap={"round"}
        strokeLinejoin={"round"}
      ></circle>

      <circle
        cx={"12"}
        cy={"6"}
        r={"1.25"}
        stroke={"currentColor"}
        strokeWidth={"1.5"}
        strokeLinecap={"round"}
        strokeLinejoin={"round"}
      ></circle>

      <circle
        cx={"17"}
        cy={"14"}
        r={"1.25"}
        stroke={"currentColor"}
        strokeWidth={"1.5"}
        strokeLinecap={"round"}
        strokeLinejoin={"round"}
      ></circle>

      <path
        d={
          "M9.5 19.25s-.25-2.5-2.5-2.5-2.25 2.5-2.25 2.5m9.75 0s-.25-2.5-2.5-2.5-2.5 2.5-2.5 2.5m9.75 0s0-2.5-2.25-2.5-2.5 2.5-2.5 2.5"
        }
        stroke={"currentColor"}
        strokeWidth={"1.5"}
        strokeLinecap={"round"}
        strokeLinejoin={"round"}
      ></path>
    </svg>
  );
}

export default Icon10Icon;
/* prettier-ignore-end */
