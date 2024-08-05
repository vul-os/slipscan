// Stepper.jsx
import { cn } from "@/lib/utils";
import React, { forwardRef } from "react";
import { StepperProvider, useStepper } from "./context"; // Import StepperProvider and useStepper
import { Step } from "./step";
import { useMediaQuery } from "./use-media-query"; // Import media query hook

// Variable sizes for stepper icon sizes
const VARIABLE_SIZES = {
  sm: "36px",
  md: "40px",
  lg: "44px",
};

// Stepper component definition
const Stepper = forwardRef((props, ref) => {
  // Destructuring props
  const {
    className,
    children,
    orientation: orientationProp,
    state,
    responsive,
    checkIcon,
    errorIcon,
    onClickStep,
    mobileBreakpoint,
    expandVerticalSteps = false,
    initialStep = 0,
    size,
    steps,
    variant,
    styles,
    variables,
    scrollTracking = false,
    ...rest
  } = props;

  // Converting children to an array
  const childArr = React.Children.toArray(children);

  const items = [];

  // Extracting Step components and footer content
  const footer = childArr.map((child, _index) => {
    if (!React.isValidElement(child)) {
      throw new Error("Stepper children must be valid React elements.");
    }
    if (child.type === Step) {
      items.push(child);
      return null;
    }

    return child;
  });

  // Determining step count
  const stepCount = items.length;

  // Check if the view is mobile using a media query
  const isMobile = useMediaQuery(
    `(max-width: ${mobileBreakpoint || "768px"})`
  );

  // Check if the stepper is clickable
  const clickable = !!onClickStep;

  // Determine orientation based on media query
  const orientation = isMobile && responsive ? "vertical" : orientationProp;

  // Check if the orientation is vertical
  const isVertical = orientation === "vertical";

  return (
    <StepperProvider
      // Passing context values to StepperProvider
      initialStep={initialStep}
      steps={steps}
      state={state}
      size={size}
      responsive={responsive}
      checkIcon={checkIcon}
      errorIcon={errorIcon}
      onClickStep={onClickStep}
      clickable={clickable}
      stepCount={stepCount}
      isVertical={isVertical}
      variant={variant || "circle"}
      expandVerticalSteps={expandVerticalSteps}
      scrollTracking={scrollTracking}
      styles={styles}
    >
      <div
        ref={ref}
        className={cn(
          "stepper__main-container",
          "flex w-full flex-wrap",
          stepCount === 1 ? "justify-end" : "justify-between",
          orientation === "vertical" ? "flex-col" : "flex-row",
          variant === "line" && orientation === "horizontal" && "gap-4",
          className,
          styles?.["main-container"]
        )}
        style={{
          "--step-icon-size":
            variables?.["--step-icon-size"] || `${VARIABLE_SIZES[size || "md"]}`,
          "--step-gap": variables?.["--step-gap"] || "8px",
        }}
        {...rest}
      >
        <VerticalContent>{items}</VerticalContent>
      </div>
      {orientation === "horizontal" && (
        <HorizontalContent>{items}</HorizontalContent>
      )}
      {footer}
    </StepperProvider>
  );
});

Stepper.defaultProps = {
  size: "md",
  orientation: "horizontal",
  responsive: true,
};

const VerticalContent = ({ children }) => {
  const { activeStep } = useStepper();

  const childArr = React.Children.toArray(children);
  const stepCount = childArr.length;

  return (
    <>
      {React.Children.map(children, (child, i) => {
        const isCompletedStep =
          (React.isValidElement(child) && child.props.isCompletedStep) ??
          i < activeStep;
        const isLastStep = i === stepCount - 1;
        const isCurrentStep = i === activeStep;

        const stepProps = {
          index: i,
          isCompletedStep,
          isCurrentStep,
          isLastStep,
        };

        if (React.isValidElement(child)) {
          return React.cloneElement(child, stepProps);
        }
        return null;
      })}
    </>
  );
};

const HorizontalContent = ({ children }) => {
  const { activeStep } = useStepper();
  const childArr = React.Children.toArray(children);

  if (activeStep > childArr.length) {
    return null;
  }

  return (
    <>
      {React.Children.map(childArr[activeStep], (node) => {
        if (!React.isValidElement(node)) {
          return null;
        }
        return React.Children.map(node.props.children, (childNode) => childNode);
      })}
    </>
  );
};

export { Stepper, Step, useStepper };
